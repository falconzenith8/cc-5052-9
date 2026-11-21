// The replication session. Strategy depends only on client feedback: which
// ticks the client actually installed and confirmed, which of those baselines
// both ends still retain under their byte budgets, and the measured frame cost.

import {
  worldDigest, equalDigest, toHex, HASH_BYTES, PROTOCOL_VERSION,
} from './wire.js';
import { encodeTiles } from './packets.js';
import {
  LabSim, BaselineStore, SnapshotRing, buildFramePayload, FRAME_KIND, countLive,
} from './lab.js';
import { chooseStrategy, STRATEGY } from './policy.js';
import { FrameCollector, validateAndApplyFrame } from './frames.js';

export const DEFAULT_CONFIG = Object.freeze({
  seed: 20261120,
  stationary: 120,
  moving: 12,
  transientCap: 4,
  tickMs: 40,                    // 25 Hz authority
  baselineBudgetBytes: 3200,     // authority baseline ring
  clientBaselineBudgetBytes: 3200,
  maxBaselineAgeTicks: 45,
  deltaToCheckpointRatio: 0.72,
  frameTimeoutMs: 500,           // client waits this long before resuming
  maxResumesBeforeCheckpoint: 2,
  dropEveryFrames: 7,            // deliberate middle-tile loss cadence
  reorderTiles: true,
  ackDelayMs: 0,                 // authority deliberately slow to process acks
  periodicBaselineTicks: 10,
});

// ---------------------------------------------------------------------------
// Authority

export class Authority {
  constructor(config, { sessionId = 1, onTiles, onStatus } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionId = sessionId;
    this.sim = new LabSim(this.config);
    this.baselines = new BaselineStore(this.config.baselineBudgetBytes);
    this.ring = new SnapshotRing(this.config.baselineBudgetBytes * 8, 512);
    const initial = this.sim.states();
    this.baselines.put(0, initial, worldDigest(initial));
    this.ring.put(0, initial, worldDigest(initial));
    this.onTiles = onTiles || (() => {});
    this.onStatus = onStatus || (() => {});
    this.seq = 0;
    this.frameId = 0;
    this.framesSent = 0;
    this.framesSentByKind = { delta: 0, checkpoint: 0 };
    this.framesDropped = 0;
    this.history = new Map();       // seq -> { tick, nonce, worldDigest, kind }
    this.pendingAnswer = null;
    this.clientConfirmedTick = 0;
    this.clientAckSeq = 0;
    this.clientDigest = null;
    this.clientBudget = null;
    this.forceCheckpointPending = true;
    this.inFlightTick = null;
    this.audit = [];
    this.lastDecision = null;
    this.paused = false;
    this.claimedAcks = new Set();
    this._lastTickAt = Date.now();
    this.tickTimer = null;
  }

  // An ack is trusted only if it names a frame we actually sent and repeats the
  // frame's nonce and the canonical digest of the world that frame installs.
  acceptAck(ack) {
    if (ack.protocol !== PROTOCOL_VERSION) return { ok: false, reason: 'protocol mismatch' };
    if (ack.sessionId !== this.sessionId) return { ok: false, reason: 'wrong session' };
    const sent = this.history.get(ack.seq);
    if (!sent) return { ok: false, reason: `seq ${ack.seq} was never sent` };
    if (ack.nonce !== sent.nonce) {
      return { ok: false, reason: `nonce ${ack.nonce} does not match frame nonce ${sent.nonce}` };
    }
    if (!equalDigest(ack.digest, sent.digest)) {
      return { ok: false, reason: `ack digest ${toHex(ack.digest)} != installed world digest ${toHex(sent.digest)}` };
    }
    if (ack.tick !== sent.tick) {
      return { ok: false, reason: `ack tick ${ack.tick} != frame tick ${sent.tick}` };
    }
    const key = `${ack.seq}:${ack.nonce}:${toHex(ack.digest)}`;
    const duplicate = this.claimedAcks.has(key);
    this.claimedAcks.add(key);
    if (this.claimedAcks.size > 512) this.claimedAcks.clear();

    this.clientConfirmedTick = ack.tick;
    this.clientAckSeq = ack.seq;
    this.clientDigest = ack.digest;
    this.clientBudget = ack.budget || null;
    this.pendingAnswer = { seq: ack.seq, tick: ack.tick, digest: ack.digest, duplicate };
    // The confirmed tick's baseline is what "keep the older common baseline"
    // protects; pinning is advisory, trim() may still not fit it.
    const snap = this.ring.get(ack.tick);
    if (snap) this.baselines.put(snap.tick, snap.states, snap.digest);
    this.baselines.addPin(ack.tick, 3);
    return { ok: true, duplicate };
  }

  requestCheckpoint(reason) {
    this.forceCheckpointPending = true;
    this.checkpointReason = reason || 'client asked for a full restart';
    this.audit.push({
      tick: this.sim.tick, kind: STRATEGY.CHECKPOINT, reason: 'client-request',
      detail: this.checkpointReason, kind_forced: true,
    });
  }

  start() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), this.config.tickMs);
  }

  stop() { if (this.tickTimer) clearInterval(this.tickTimer); this.tickTimer = null; }

  tick() {
    const now = Date.now();
    if (now - this._lastTickAt > this.config.tickMs * 4) {
      // A stalled event loop should not make the authority's clock jump by
      // many ticks at once; the sim and the wall clock stay roughly aligned.
      this._lastTickAt = now - this.config.tickMs;
    }
    this._lastTickAt += this.config.tickMs;
    this.sim.step();
    const tick = this.sim.tick;
    const states = this.sim.states();
    const digest = worldDigest(states);
    // The ring keeps every recent tick available as a potential baseline; the
    // BaselineStore still owns the byte budget for what is actually retained.
    this.ring.put(tick, states, digest);
    const forced = this.forceCheckpointPending;
    if (!this.pendingAnswer && !forced) return;

    const planned = this._planFrame(tick, states, digest, forced);
    if (forced) this.forceCheckpointPending = false;
    if (!planned) return;
    // Keep the state a frame is built from so the client can land on it, and
    // keep the confirmed tick's baseline pinned against the small budget.
    this.baselines.put(tick, states, digest);
    // Pin exactly the two states a healthy exchange needs: what the client has
    // confirmed and the frame we are about to send. Everything else is
    // speculative and must not push those two out of the byte budget.
    if (this.inFlightTick != null) this.baselines.removePin(this.inFlightTick);
    this.inFlightTick = tick;
    this.baselines.addPin(tick, 2);
    if (this.clientConfirmedTick) this.baselines.addPin(this.clientConfirmedTick, 3);
    this.baselines.prunePins(
      tick, this.config.maxBaselineAgeTicks,
      [this.clientConfirmedTick, this.inFlightTick],
    );
    this._emitFrame(planned, tick, states, digest);
  }

  _planFrame(currentTick, currentStates, currentDigest, forced = false) {
    const confirmedTick = this.clientConfirmedTick;
    const retained = this.clientBudget && this.clientBudget.retained
      ? this.clientBudget.retained
      : [];
    if (confirmedTick && retained.length === 0) {
      retained.push({ tick: confirmedTick, digest: toHex(this.clientDigest) });
    }
    // Only baselines both ends still hold, at or below what the client has
    // installed, may serve as the common baseline. The client retires old
    // baselines aggressively under its own budget, so the confirmed tick it
    // named in the ack is always an acceptable fallback when the ring still
    // has it; that is exactly the "keep an older common baseline" path.
    let common = this.baselines.newestCommon(retained, confirmedTick);
    if (!common) {
      const ringHit = this.ring.get(confirmedTick);
      if (ringHit && equalDigest(ringHit.digest, this.clientDigest)) {
        common = this.baselines.put(ringHit.tick, ringHit.states, ringHit.digest);
      }
    }

    const delta = common
      ? buildFramePayload({
        seq: this.seq + 1, tick: currentTick, base: common,
        current: currentStates, kind: FRAME_KIND.DELTA,
      })
      : null;
    const checkpoint = buildFramePayload({
      seq: this.seq + 1, tick: currentTick, base: null,
      current: currentStates, kind: FRAME_KIND.CHECKPOINT,
    });

    const decision = chooseStrategy({
      installedTick: confirmedTick,
      baselineAvailable: !!common,
      baselineTick: common ? common.tick : null,
      baselineAgeTicks: common ? currentTick - common.tick : Infinity,
      deltaBytes: delta ? delta.payload.length : Infinity,
      checkpointBytes: checkpoint.payload.length,
      maxBaselineAgeTicks: this.config.maxBaselineAgeTicks,
      deltaToCheckpointRatio: this.config.deltaToCheckpointRatio,
      retainedBaselines: retained.length,
      baselineBudgetBytes: this.config.baselineBudgetBytes,
      serverBaselineBytes: this.baselines.bytes,
    });

    if (forced) {
      decision.kind = STRATEGY.CHECKPOINT;
      decision.reason = 'client-request';
      decision.detail = `client requested a restart: ${this.checkpointReason || 'no reason given'}`;
    }
    const useDelta = !forced && decision.kind === STRATEGY.DELTA && delta;
    return {
      payload: useDelta ? delta.payload : checkpoint.payload,
      kind: useDelta ? FRAME_KIND.DELTA : FRAME_KIND.CHECKPOINT,
      base: useDelta ? common : null,
      recordCount: useDelta ? delta.recordCount : checkpoint.recordCount,
      decision: {
        ...decision,
        deltaBytes: delta ? delta.payload.length : null,
        checkpointBytes: checkpoint.payload.length,
        baseTick: common ? common.tick : null,
      },
    };
  }

  _emitFrame(planned, tick, states, digest) {
    this.seq += 1;
    this.frameId += 1;
    const nonce = (this.frameId * 2654435761) >>> 0;
    this.history.set(this.seq, { tick, nonce, digest, kind: planned.kind });
    if (this.history.size > 256) {
      const oldest = Math.min(...this.history.keys());
      this.history.delete(oldest);
    }
    this.framesSent++;
    if (planned.kind === FRAME_KIND.DELTA) this.framesSentByKind.delta++;
    else this.framesSentByKind.checkpoint++;
    this.lastDecision = planned.decision;

    const encoded = encodeTiles({
      sessionId: this.sessionId,
      frameId: this.frameId,
      tick, seq: this.seq, nonce,
      kind: planned.kind,
      payload: planned.payload,
    });
    const tiles = encoded.tiles;
    const meta = {
      sessionId: this.sessionId, frameId: this.frameId, seq: this.seq, tick, nonce,
      kind: planned.kind, bytes: planned.payload.length, tiles: tiles.length,
      baseTick: planned.base ? planned.base.tick : 0,
      recordCount: planned.recordCount,
      live: countLive(states),
      decision: planned.decision,
      worldDigest: toHex(digest),
      payloadDigest: toHex(encoded.frameDigest),
    };
    this.pendingAnswer = null;
    this.onTiles(tiles, meta);
  }

  // Simulated middle-tile loss. Returns the surviving tiles; the caller's
  // impairment layer applies reordering and delay.
  dropMiddle(tiles) {
    if (tiles.length < 2) return { tiles, dropped: null };
    const mid = Math.floor(tiles.length / 2);
    const kept = tiles.slice(0, mid).concat(tiles.slice(mid + 1));
    this.framesDropped++;
    return { tiles: kept, dropped: mid };
  }

  status() {
    const b = this.baselines.describe();
    return {
      tick: this.sim.tick,
      seq: this.seq,
      frameId: this.frameId,
      framesSent: this.framesSent,
      framesSentByKind: { ...this.framesSentByKind },
      framesDropped: this.framesDropped,
      baselines: b,
      client: {
        confirmedTick: this.clientConfirmedTick,
        ackSeq: this.clientAckSeq,
        digest: this.clientDigest ? toHex(this.clientDigest) : null,
        budget: this.clientBudget,
      },
      lastDecision: this.lastDecision,
      audit: this.audit.slice(-24),
      hotIds: [...this.sim.hotIds].sort((a, b2) => a - b2),
      lifecycle: [...this.sim.lifecycle.entries()].map(([id, l]) => ({ id, ...l })),
      config: this.config,
    };
  }
}

// ---------------------------------------------------------------------------
// Client

export class LabClient {
  constructor({ sessionId = 1, config = {}, onInstall, onEvent, now = () => Date.now() } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionId = sessionId;
    this.onInstall = onInstall || (() => {});
    this.onEvent = onEvent || (() => {});
    this.now = now;
    this.states = new Map();
    this.tick = 0;
    this.seq = 0;
    this.digest = null;
    this.pendingNonce = null;
    this.ackSentAt = 0;
    this.resumes = 0;
    this.baselines = new BaselineStore(this.config.clientBaselineBudgetBytes);
    this.baselines.put(0, new Map(), worldDigest(new Map()));
    this.collector = new FrameCollector({
      sessionId,
      onFrame: (f) => this.intake(f),
      onReject: (e) => this.emit({ type: 'reject', ...e }),
    });
    this.stats = {
      framesInstalled: 0, framesRejected: 0, framesIncomplete: 0,
      deltas: 0, checkpoints: 0, bytesReceived: 0, tilesReceived: 0,
      resumes: 0, checkpointRequests: 0, installs: 0,
    };
    this.recovery = null;         // one entry per recovery episode
    this.recoveryLog = [];
    this.installLog = [];
    this.waitingSince = 0;
    this.expectingFrame = false;
  }

  emit(ev) { this.onEvent(ev); }

  receivePacket(bytes) {
    this.stats.bytesReceived += bytes.length;
    this.stats.tilesReceived++;
    this.collector.ingest(bytes);
  }

  intake({ payload, header }) {
    // All verification happens against baselines that were themselves fully
    // installed. A half-received frame never becomes a baseline.
    const check = validateAndApplyFrame({
      payload,
      frameHeader: header,
      baselines: this.baselines,
      installedTick: this.tick,
      installedDigest: this.digest,
    });
    if (!check.ok) {
      this.stats.framesRejected++;
      this.emit({ type: 'reject', stage: 'frame', reason: check.reason, seq: check.seq, tick: check.tick });
      if (check.requestCheckpoint) this.requestCheckpoint(check.reason);
      return;
    }
    const started = this.now();
    // Atomic swap: only after every tile, CRC, frame digest, baseline digest,
    // field bound and count check has passed does the renderable world change.
    this.states = check.install.states;
    this.seq = check.install.seq;
    this.pendingNonce = header.nonce;
    this.stats.framesInstalled++;
    this.stats.installs++;
    if (header.kind === FRAME_KIND.CHECKPOINT) this.stats.checkpoints++;
    else this.stats.deltas++;
    this.baselines.put(check.install.tick, check.install.states, check.install.digest);
    const kind = header.kind === FRAME_KIND.CHECKPOINT ? 'checkpoint' : 'delta';
    const episode = this.recovery;
    if (episode && episode.pending) {
      episode.pending = false;
      episode.resolvedTick = check.install.tick;
      episode.ms = this.now() - episode.startedAt;
      episode.ticks = check.install.tick - episode.fromTick;
      episode.installedKind = kind;
      this.recovery = null;
      this.recoveryLog.push(episode);
      this.emit({ type: 'recovered', ...episode });
    }
    this.tick = check.install.tick;
    this.digest = check.install.digest;
    this.expectingFrame = false;
    this.resumes = 0;
    this.installLog.push({
      tick: this.tick, seq: this.seq, kind, bytes: header.totalLen,
      baseTick: check.install.baseTick, digest: toHex(this.digest),
      applyMs: this.now() - started,
    });
    if (this.installLog.length > 400) this.installLog.shift();
    this.onInstall({
      tick: this.tick, seq: this.seq, digest: this.digest, states: this.states,
      kind, bytes: header.totalLen, nonce: this.pendingNonce, baseTick: check.install.baseTick,
      applyMs: this.now() - started,
    });
    this.ackNow();
  }

  // Ack always quotes the currently installed world. A fresh nonce retires the
  // previous confirmation so the authority cannot build from a stale frame.
  ackNow() {
    if (!this.digest) return null;
    const ack = {
      type: 'ack',
      protocol: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      seq: this.seq,
      tick: this.tick,
      digest: this.digest,
      nonce: this.pendingNonce,
      budget: { retained: this.retainedBaselines(), bytes: this.baselines.bytes },
      ts: this.now(),
    };
    this.ackSentAt = this.now();
    this.expectingFrame = true;
    this.emit({ type: 'ack', ack });
    return ack;
  }

  retainedBaselines() {
    return this.baselines.entries.map(e => ({ tick: e.tick, digest: toHex(e.digest), bytes: e.bytes }));
  }

  requestCheckpoint(reason) {
    this.stats.checkpointRequests++;
    this.emit({ type: 'control', action: 'checkpoint', reason });
  }

  // Called on a timer. If the expected answer never completes, the last
  // installed state is re-confirmed (cheap: allows an older, larger delta) and
  // after repeated failures a full checkpoint is requested instead.
  watchdog() {
    if (!this.expectingFrame || !this.ackSentAt) return;
    const waited = this.now() - this.ackSentAt;
    if (waited < this.config.frameTimeoutMs) return;
    for (const [frameId, slot] of this.collector.frames) {
      if (this.now() - slot.startedAt > this.config.frameTimeoutMs) {
        this.collector.dropFrame(frameId);
        this.stats.framesIncomplete++;
        this.emit({ type: 'incomplete', frameId, received: slot.assembly.received, count: slot.assembly.expected });
      }
    }
    this.collector.dropStale(3, this.seq + 1);
    this.resumes++;
    this.stats.resumes++;
    if (this.resumes > this.config.maxResumesBeforeCheckpoint) {
      this.recovery = {
        pending: true, reason: 'repeated-incomplete-frames',
        fromTick: this.tick, startedAt: this.now(),
        strategy: 'checkpoint-request',
      };
      this.ackSentAt = 0;
      this.requestCheckpoint('repeated incomplete frames');
      return;
    }
    const prior = this.recovery;
    if (!prior) {
      this.recovery = {
        pending: true, reason: 'frame-not-completed',
        fromTick: this.tick, startedAt: this.now(),
        strategy: 'reconfirm-last-installed',
      };
    }
    this.ackNow();
  }

  status() {
    return {
      tick: this.tick, seq: this.seq,
      digest: this.digest ? toHex(this.digest) : null,
      stats: { ...this.stats },
      baselines: this.baselines.describe(),
      collector: {
        ...this.collector.stats,
        bufferedBytes: this.collector.bufferedBytes,
        peakBufferedBytes: this.collector.maxBufferedBytes,
        openFrames: this.collector.frames.size,
      },
      installLog: this.installLog.slice(-20),
      recovery: this.recovery,
      recoveryLog: this.recoveryLog.slice(-12),
    };
  }
}
