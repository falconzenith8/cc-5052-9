// Deterministic virtual-time link between an Authority and a LabClient.
// Delivery queues model latency, jitter, reordering and middle-tile loss.
// Time advances in whole authority ticks so runs are reproducible.

import { Authority, LabClient, DEFAULT_CONFIG } from './session.js';
import { decodeTileHeader } from './packets.js';
import { FRAME_KIND, LabSim } from './lab.js';
import { worldDigest, toHex } from './wire.js';

export class AuthoritativeLink {
  constructor({
    config = {}, impairment = {}, seed = 7, clientConfig = {},
  } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.impairment = {
      latencyMs: 0,
      jitterMs: 0,
      reorder: false,
      dropMiddleEveryFrames: 0,
      ackDelayMs: 0,
      ...impairment,
    };
    this.startSeed = seed;
    this.seed = seed >>> 0 || 7;
    this.nowMs = 0;
    this.stepIndex = 0;
    this.toClient = [];
    this.toServer = [];
    this.framesOut = 0;
    this.deliveredTiles = 0;
    this.droppedTiles = 0;
    this.bytesDelivered = 0;
    this.events = [];
    this.authoritative = new LabSim(this.config); // independent replay oracle

    this.authority = new Authority(this.config, {
      sessionId: 1,
      onTiles: (tiles, meta) => this._queueFrame(tiles, meta),
    });
    // Authority must be driven by our virtual clock, not its own timer.
    this.authority.stop();

    this.client = new LabClient({
      sessionId: 1,
      config: { ...this.config, ...clientConfig },
      now: () => this.nowMs,
      onInstall: (e) => this._onInstall(e),
      onEvent: (e) => this._onClientEvent(e),
    });
    this.maxClientBuffered = 0;
    this.maxServerBaselineBytes = 0;
    this.maxClientBaselineBytes = 0;
    this.installHistory = [];
    this.recoveries = [];
  }

  _rand() {
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return (this.seed % 100000) / 100000;
  }

  _queueFrame(tiles, meta) {
    this.framesOut++;
    let list = tiles.map((bytes) => ({ bytes, index: null }));
    for (let i = 0; i < list.length; i++) {
      const hdr = decodeTileHeader(list[i].bytes);
      list[i].index = hdr.index;
    }
    if (this.impairment.reorder && list.length > 2) {
      for (let i = 0; i + 1 < list.length; i += 2) {
        [list[i], list[i + 1]] = [list[i + 1], list[i]];
      }
      list.push(list.shift());
    }
    if (this.impairment.dropMiddleEveryFrames > 0 &&
        this.framesOut % this.impairment.dropMiddleEveryFrames === 0 &&
        list.length >= 2) {
      const mid = Math.floor(list.length / 2);
      const [gone] = list.splice(mid, 1);
      this.droppedTiles++;
      this._event({ type: 'tile-drop', frameId: meta.frameId, tick: meta.tick, tile: gone.index, count: tiles.length });
    }
    list.forEach((tile, i) => {
      const delay = this.impairment.latencyMs +
        (this.impairment.jitterMs ? Math.floor(this._rand() * this.impairment.jitterMs) : 0) + i * 2;
      this.toClient.push({ at: this.nowMs + delay, bytes: tile.bytes });
    });
    this._event({ type: 'tx', tick: meta.tick, kind: meta.kind, bytes: meta.bytes, tiles: tiles.length, baseTick: meta.baseTick, decision: meta.decision });
  }

  _onClientEvent(ev) {
    if (ev.type === 'ack') {
      this.toServer.push({ at: this.nowMs + this.impairment.ackDelayMs, ack: ev.ack });
      return;
    }
    if (ev.type === 'control' && ev.action === 'checkpoint') {
      this.authority.requestCheckpoint(ev.reason);
      this._event({ type: 'checkpoint-requested', reason: ev.reason, tick: this.client.tick });
      return;
    }
    if (ev.type === 'reject' || ev.type === 'incomplete') {
      this._event({ type: 'client-' + ev.type, ...ev });
    }
  }

  _onInstall(e) {
    this.installHistory.push({
      tick: e.tick, seq: e.seq, kind: e.kind, bytes: e.bytes,
      baseTick: e.baseTick, digest: toHex(e.digest), applyMs: e.applyMs,
    });
    this.maxClientBuffered = Math.max(this.maxClientBuffered, this.client.collector.maxBufferedBytes);
    this.maxClientBaselineBytes = Math.max(this.maxClientBaselineBytes, this.client.baselines.peakBytes);
    this.maxServerBaselineBytes = Math.max(this.maxServerBaselineBytes, this.authority.baselines.peakBytes);
  }

  _event(e) {
    this.events.push({ atMs: this.nowMs, ...e });
    if (this.events.length > 4000) this.events.shift();
  }

  // Deliver everything due at or before now, in arrival order.
  _flush(queue, apply) {
    const due = [];
    const keep = [];
    for (const item of queue) (item.at <= this.nowMs ? due : keep).push(item);
    queue.length = 0;
    queue.push(...keep);
    for (const item of due) apply(item);
  }

  step() {
    this.stepIndex++;
    this.nowMs += this.config.tickMs;
    this.authority.tick();
    this._flush(this.toClient, (item) => {
      this.deliveredTiles++;
      this.bytesDelivered += item.bytes.length;
      this.client.receivePacket(item.bytes);
    });
    this._flush(this.toServer, (item) => {
      const res = this.authority.acceptAck(item.ack);
      if (!res.ok) this._event({ type: 'ack-rejected', reason: res.reason });
    });
    // Watchdog runs on the same virtual clock. Client timeouts are measured in
    // multiples of a tick, not wall-clock, so runs stay deterministic.
    if (this.stepIndex % 2 === 0) this.client.watchdog();
    if (this.authority.baselines.peakBytes > this.maxServerBaselineBytes) {
      this.maxServerBaselineBytes = this.authority.baselines.peakBytes;
    }
    if (this.client.collector.maxBufferedBytes > this.maxClientBuffered) {
      this.maxClientBuffered = this.client.collector.maxBufferedBytes;
    }
  }

  run(steps) { for (let i = 0; i < steps; i++) this.step(); }

  // Compare installed client world to the independent authority replay at the
  // same tick. This is the ground truth the UI and verifier both use.
  matchAtClientTick() {
    const tick = this.client.tick;
    if (tick <= 0) return { ok: false, reason: 'no installed frame yet' };
    while (this.authoritative.tick < tick) this.authoritative.step();
    const truth = this.authoritative.states();
    const client = this.client.states;
    const diffs = [];
    const ids = new Set([...truth.keys(), ...client.keys()]);
    for (const id of ids) {
      const a = truth.get(id);
      const b = client.get(id);
      if (!a || !b) { diffs.push({ id, field: 'presence', truth: a ? 'present' : 'absent', client: b ? 'present' : 'absent' }); continue; }
      for (const f of ['px', 'py', 'rot', 'on', 'kind', 'label']) {
        if (a[f] !== b[f]) diffs.push({ id, field: f, truth: a[f], client: b[f] });
      }
    }
    return {
      ok: diffs.length === 0,
      tick,
      diffs: diffs.slice(0, 20),
      truthDigest: toHex(worldDigest(truth)),
      clientDigest: toHex(worldDigest(client)),
    };
  }

  sample() {
    const clientStatus = this.client.status();
    const authorityStatus = this.authority.status();
    const match = this.matchAtClientTick();
    return {
      step: this.stepIndex,
      nowMs: this.nowMs,
      authorityTick: authorityStatus.tick,
      clientTick: this.client.tick,
      clientSeq: this.client.seq,
      clientDigest: this.client.digest ? toHex(this.client.digest) : null,
      match: { ok: match.ok, diffs: match.diffs, truthDigest: match.truthDigest, clientDigest: match.clientDigest },
      framesSent: authorityStatus.framesSent,
      framesSentByKind: authorityStatus.framesSentByKind,
      framesInstalled: clientStatus.stats.framesInstalled,
      framesRejected: clientStatus.stats.framesRejected,
      deltas: clientStatus.stats.deltas,
      checkpoints: clientStatus.stats.checkpoints,
      framesLost: this.droppedTiles,
      lastDecision: authorityStatus.lastDecision,
      serverBaseline: authorityStatus.baselines,
      clientBaseline: clientStatus.baselines,
      clientCollector: clientStatus.collector,
      recoveryLog: clientStatus.recoveryLog,
      clientRecovery: clientStatus.recovery,
      peak: {
        serverBaselineBytes: this.maxServerBaselineBytes,
        clientBaselineBytes: this.maxClientBaselineBytes,
        clientBufferBytes: this.maxClientBuffered,
      },
      bytesDelivered: this.bytesDelivered,
      installLog: this.installHistory.slice(-8),
    };
  }
}

export { FRAME_KIND };
