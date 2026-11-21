// Deterministic authority simulation plus the replication planning pieces that
// the server, the headless client and the offline verifier share.

import {
  stateFromFloat, encodeStateRecord, estimateRecordBytes, worldDigest,
  ByteWriter, HASH_BYTES, quantizePosition, quantizeRotation,
} from './wire.js';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32). Same seed => same world on every machine.

export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PRESETS = Object.freeze({
  mixed: {
    seed: 20261120,
    stationary: 100,
    moving: 10,
    pulser: 14,
    transientCap: 4,
    tickMs: 40,
    baselineBudgetBytes: 3200,
    clientBaselineBudgetBytes: 3200,
    maxBaselineAgeTicks: 45,
    deltaToCheckpointRatio: 0.72,
    maxResumesBeforeCheckpoint: 2,
    frameTimeoutMs: 500,
  },
});

// ---------------------------------------------------------------------------
// The lab world. Objects are float-positioned here; the wire only ever carries
// quantized levels. Stationary objects stay bit-stable so per-field deltas
// against a common baseline compress to almost nothing.

export class LabSim {
  constructor(config) {
    this.config = { ...config };
    this.rng = makeRng(config.seed);
    this.tick = 0;
    this.objects = new Map();
    this.nextTransientId = 5001;
    this.transients = [];
    this.lifecycle = new Map();
    this.hotIds = new Set();
    this._spawnStationary();
    this._spawnMoving();
    this._spawnPulsers();
  }

  _spawnStationary() {
    const rng = this.rng;
    const n = this.config.stationary;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    for (let i = 0; i < n; i++) {
      const id = 100 + i;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = -180 + col * (360 / cols) + (rng() - 0.5) * 4;
      const y = -110 + row * (220 / rows) + (rng() - 0.5) * 4;
      this.objects.set(id, {
        id, kind: 'stationary',
        x, y, rot: rng() * Math.PI * 2,
        on: rng() < 0.55 ? 1 : 0,
        label: `S${String(i).padStart(3, '0')}`,
      });
      this.lifecycle.set(id, { bornTick: 0, diedTick: null });
    }
  }

  _spawnMoving() {
    const rng = this.rng;
    for (let i = 0; i < this.config.moving; i++) {
      const id = 1001 + i;
      this.objects.set(id, {
        id, kind: 'moving',
        x: 0, y: 0, rot: 0, on: 1,
        label: `M${String(i).padStart(2, '0')}`,
        cx: -140 + (i % 4) * 90 + rng() * 20,
        cy: -80 + Math.floor(i / 4) * 70 + rng() * 20,
        ax: 30 + rng() * 60,
        ay: 20 + rng() * 40,
        wx: 0.02 + rng() * 0.05,
        wy: 0.03 + rng() * 0.05,
        phaseX: rng() * Math.PI * 2,
        phaseY: rng() * Math.PI * 2,
        spin: (rng() < 0.5 ? -1 : 1) * (0.02 + rng() * 0.04),
        blink: 20 + Math.floor(rng() * 50),
        blinkPhase: Math.floor(rng() * 100),
      });
      this.lifecycle.set(id, { bornTick: 0, diedTick: null });
      this.hotIds.add(id);
    }
  }

  // Pulsers move only during a short window every few dozen ticks. Against a
  // fresh baseline they are nearly free; against an old common baseline they
  // have drifted to a different phase, which makes aged deltas measurably
  // larger. That is what lets recovery strategy respond to baseline age.
  _spawnPulsers() {
    const rng = this.rng;
    const n = this.config.pulser || 0;
    for (let i = 0; i < n; i++) {
      const id = 2001 + i;
      const period = 26 + Math.floor(rng() * 30);
      this.objects.set(id, {
        id, kind: 'pulser',
        x: -170 + (i % 7) * 52 + rng() * 10,
        y: 70 + Math.floor(i / 7) * 34 + rng() * 8,
        rot: 0,
        on: i % 3 === 0 ? 1 : 0,
        label: `P${String(i).padStart(2, '0')}`,
        period,
        phase: Math.floor(rng() * period),
        amp: 18 + rng() * 22,
        originX: 0,
        originY: 0,
      });
      const o = this.objects.get(id);
      o.originX = o.x;
      o.originY = o.y;
      this.lifecycle.set(id, { bornTick: 0, diedTick: null });
      this.hotIds.add(id);
    }
  }

  _spawnTransient() {
    if (this.transients.length >= this.config.transientCap) return;
    const rng = this.rng;
    const id = this.nextTransientId++;
    this.objects.set(id, {
      id, kind: 'transient',
      x: -150 + rng() * 300,
      y: -90 + rng() * 180,
      rot: rng() * Math.PI * 2,
      on: 1,
      label: `T${id}`,
      lifeTicks: 90 + Math.floor(rng() * 120),
    });
    this.lifecycle.set(id, { bornTick: this.tick, diedTick: null });
    this.transients.push(id);
    this.hotIds.add(id);
  }

  step() {
    this.tick += 1;
    const t = this.tick;
    for (const obj of this.objects.values()) {
      if (obj.kind === 'moving') {
        obj.x = obj.cx + obj.ax * Math.cos(obj.wx * t + obj.phaseX);
        obj.y = obj.cy + obj.ay * Math.sin(obj.wy * t + obj.phaseY);
        obj.rot += obj.spin;
        obj.on = ((t + obj.blinkPhase) % obj.blink) < obj.blink * 0.6 ? 1 : 0;
      } else if (obj.kind === 'pulser') {
        const local = (t + obj.phase) % obj.period;
        // A pulse lasts ~40% of the period; outside it the object is bit-stable.
        if (local < obj.period * 0.4) {
          const u = local / (obj.period * 0.4);
          obj.x = obj.originX + obj.amp * Math.sin(u * Math.PI);
          obj.y = obj.originY;
          obj.rot = ((obj.phase * 37 + Math.floor(u * 8)) % 64) / 64 * Math.PI * 2;
          obj.on = local < obj.period * 0.2 ? 1 : 0;
        } else {
          obj.x = obj.originX;
          obj.y = obj.originY;
          obj.rot = 0;
          obj.on = 0;
        }
      }
    }
    // One stationary object flips a switch now and then. Everything else stays
    // bit-stable, which is what makes per-field deltas cheap.
    if (t % 97 === 0) {
      const ids = [...this.objects.values()]
        .filter(o => o.kind === 'stationary')
        .map(o => o.id);
      const o = this.objects.get(ids[(t * 7) % ids.length]);
      if (o) o.on = o.on ? 0 : 1;
    }
    if (t % 45 === 0) this._spawnTransient();
    for (const id of [...this.transients]) {
      const o = this.objects.get(id);
      if (!o) { this.transients = this.transients.filter(x => x !== id); continue; }
      if (t - this.lifecycle.get(id).bornTick >= o.lifeTicks) {
        this.objects.delete(id);
        this.lifecycle.get(id).diedTick = t;
        this.transients = this.transients.filter(x => x !== id);
      }
    }
  }

  states() {
    const out = new Map();
    for (const o of this.objects.values()) out.set(o.id, stateFromFloat(o));
    return out;
  }

  digest() { return worldDigest(this.states()); }
}

// ---------------------------------------------------------------------------
// Baseline storage with a hard byte budget. An entry is a state map for one
// tick. A pinned entry is the common baseline a confirmed client still needs;
// it is retained ahead of newer unconfirmed snapshots.

export const BASELINE_HEADER_BYTES = 12;
export const BASELINE_BYTES_PER_OBJECT = 11;

export function baselineBytesFor(count) {
  return BASELINE_HEADER_BYTES + count * BASELINE_BYTES_PER_OBJECT;
}

export function countLive(states) {
  let n = 0;
  for (const s of states.values()) if (s.alive) n++;
  return n;
}

// Every authority tick's quantized state is written to a small rolling ring so
// the store can reference a tick without copying it. The ring is bounded by
// the same byte budget; entries the store wants are never held only by the
// ring, and the ring never inflates the baseline budget accounting.
export class SnapshotRing {
  constructor(budgetBytes, maxTicks = 512) {
    this.budgetBytes = budgetBytes;
    this.maxTicks = maxTicks;
    this.byTick = new Map();
    this.order = [];
    this.bytes = 0;
  }

  put(tick, states, digest) {
    if (this.byTick.has(tick)) return this.byTick.get(tick);
    const entry = { tick, states, digest, bytes: baselineBytesFor(countLive(states)) };
    this.byTick.set(tick, entry);
    this.order.push(tick);
    this.bytes += entry.bytes;
    // Bound by tick count so a slow confirmation still finds the tick it
    // names. The byte figure is reported, not used to evict, because evicting
    // by bytes here would strand exactly the ack that is in flight.
    while (this.order.length > this.maxTicks) {
      const drop = this.order.shift();
      const e = this.byTick.get(drop);
      this.byTick.delete(drop);
      this.bytes -= e.bytes;
    }
    return entry;
  }

  get(tick) { return this.byTick.get(tick) || null; }
  describe() {
    return {
      ticks: this.order.length,
      bytes: this.bytes,
      oldestTick: this.order.length ? this.order[0] : null,
      newestTick: this.order.length ? this.order[this.order.length - 1] : null,
    };
  }
}

export class BaselineStore {
  constructor(budgetBytes) {
    this.budgetBytes = budgetBytes;
    this.entries = [];
    this.pinTicks = new Set(); // confirmed tick(s) a client still builds from
    this.pinPriority = new Map();
    this.bytes = 0;
    this.peakBytes = 0;
    this.evicted = 0;
    this.pinLost = 0;
    this.inserted = 0;
  }

  put(tick, states, digest = null) {
    const existing = this.entries.find(e => e.tick === tick);
    if (existing) return existing;
    const entry = {
      tick,
      states,
      digest: digest || worldDigest(states),
      bytes: baselineBytesFor(countLive(states)),
    };
    this.entries.push(entry);
    this.inserted++;
    this.trim();
    return entry;
  }

  get(tick) { return this.entries.find(e => e.tick === tick) || null; }

  // Pins are ordered by priority: the first hint is the confirmed baseline and
  // must survive before any speculative in-flight snapshot. Priority changes
  // are recorded even when the tick is already pinned.
  addPin(tick, priority = 1) {
    if (!Number.isInteger(tick) || tick < 0) return;
    this.pinPriority.set(tick, Math.max(priority, this.pinPriority.get(tick) ?? 1));
    if (!this.pinTicks.has(tick)) {
      this.pinTicks.add(tick);
      this.trim();
    }
  }

  removePin(tick) {
    this.pinPriority.delete(tick);
    if (this.pinTicks.delete(tick)) this.trim();
  }

  clearPins() { this.pinTicks.clear(); this.trim(); }

  // Routine (non-pinned) snapshots are speculative: dropping them frees the
  // budget for the baselines recovery actually needs. Pins are kept.
  evictUnpinned(limitBytes) {
    const keep = [];
    let total = 0;
    let removed = false;
    for (const e of this.entries) {
      const pinned = this.pinTicks.has(e.tick);
      if (!pinned && total + e.bytes > limitBytes) { this.evicted++; removed = true; continue; }
      keep.push(e);
      total += e.bytes;
    }
    if (removed) { this.entries = keep; this.recount(); }
  }

  // Drop pins that are neither a keep tick nor inside the useful age window,
  // so a long session does not accumulate pinned snapshots. keepTicks always
  // survive: they are the confirmed baseline and the frame currently in flight.
  prunePins(currentTick, maxAgeTicks, keepTicks) {
    const keep = new Set(keepTicks.filter(t => Number.isInteger(t)));
    let removed = false;
    for (const t of [...this.pinTicks]) {
      if (keep.has(t)) continue;
      if (currentTick - t > maxAgeTicks) { this.pinTicks.delete(t); removed = true; }
    }
    if (removed) this.trim();
  }

  // Newest entry at or before maxTick whose digest matches what the client
  // confirmed, and whose tick is still held by the client.
  newestCommon(clientRetained, maxTick) {
    if (!clientRetained || clientRetained.length === 0) return null;
    const want = new Map(clientRetained.map(r => [r.tick, r.digest]));
    let best = null;
    for (const e of this.entries) {
      if (e.tick > maxTick) continue;
      const d = want.get(e.tick);
      if (!d) continue;
      if (d !== hexOf(e.digest)) continue;
      if (!best || e.tick > best.tick) best = e;
    }
    return best;
  }

  trim() {
    this.entries.sort((a, b) => b.tick - a.tick);
    const keep = [];
    const kept = new Set();
    let total = 0;
    // Pinned entries first in priority order (confirmed, then in-flight, then
    // newest), while they fit the budget.
    const pinnedEntries = this.entries
      .filter(e => this.pinTicks.has(e.tick))
      .sort((a, b) => {
        const pa = this.pinPriority.get(a.tick) ?? 1;
        const pb = this.pinPriority.get(b.tick) ?? 1;
        return pb - pa || b.tick - a.tick;
      });
    for (const e of pinnedEntries) {
      if (total + e.bytes > this.budgetBytes) {
        this.pinLost++;
        this.pinTicks.delete(e.tick);
        this.pinPriority.delete(e.tick);
        continue;
      }
      keep.push(e);
      kept.add(e.tick);
      total += e.bytes;
    }
    for (const e of this.entries) {
      if (kept.has(e.tick)) continue;
      if (total + e.bytes > this.budgetBytes) { this.evicted++; continue; }
      keep.push(e);
      total += e.bytes;
    }
    this.entries = keep.sort((a, b) => b.tick - a.tick);
    this.recount();
  }

  recount() {
    this.bytes = this.entries.reduce((n, e) => n + e.bytes, 0);
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
  }

  get newestTick() { return this.entries.length ? this.entries[0].tick : null; }

  describe() {
    return {
      budgetBytes: this.budgetBytes,
      bytes: this.bytes,
      peakBytes: this.peakBytes,
      entries: this.entries.map(e => ({ tick: e.tick, bytes: e.bytes, pinned: this.pinTicks.has(e.tick) })),
      pinTicks: [...this.pinTicks].sort((a, b) => b - a),
      evicted: this.evicted,
      pinLost: this.pinLost,
    };
  }
}

function hexOf(digest) {
  let s = '';
  for (const b of digest) s += b.toString(16).padStart(2, '0');
  return s;
}

// ---------------------------------------------------------------------------
// Frame planning: encode only differences from a base map.

export const FRAME_KIND = Object.freeze({ DELTA: 1, CHECKPOINT: 2 });
export const FRAME_HEADER_BYTES = 4 + 4 + 4 + 1 + 4 + 4 + HASH_BYTES;

export function buildFramePayload({ seq, tick, base, current, kind }) {
  const records = [];
  const baseMap = base ? base.states : new Map();
  const ids = [...new Set([...baseMap.keys(), ...current.keys()])].sort((a, b) => a - b);
  for (const id of ids) {
    const state = current.get(id);
    const b = baseMap.get(id);
    if (!state || !state.alive) {
      if (b && b.alive) records.push(encodeStateRecord(id, { ...b, alive: 0 }, b));
      continue;
    }
    if (!b || !b.alive) { records.push(encodeStateRecord(id, state, null, state.label)); continue; }
    const enc = encodeStateRecord(id, state, b);
    if (enc.length > 5) records.push(enc);
  }
  const count = countLive(current);

  const w = new ByteWriter(64);
  w.u32(tick);
  w.u32(seq);
  w.u32(base ? base.tick : 0);
  w.u8(kind);
  w.u32(count);
  w.u32(records.length);
  w.bytes(base ? base.digest : new Uint8Array(HASH_BYTES));

  let total = w.length;
  for (const r of records) total += r.length;
  const out = new Uint8Array(total);
  out.set(w.finish(), 0);
  let off = w.length;
  for (const r of records) { out.set(r, off); off += r.length; }
  let recordBytes = 0;
  for (const r of records) recordBytes += r.length;
  return { payload: out, recordCount: records.length, live: count, recordBytes };
}

export function estimateFrameBytes(base, current) {
  const baseMap = base ? base.states : new Map();
  let bytes = FRAME_HEADER_BYTES;
  for (const id of [...new Set([...baseMap.keys(), ...current.keys()])]) {
    const state = current.get(id);
    const b = baseMap.get(id);
    if (!state || !state.alive) { if (b && b.alive) bytes += 5; continue; }
    if (!b || !b.alive) { bytes += estimateRecordBytes(state, null); continue; }
    bytes += Math.max(0, estimateRecordBytes(state, b) - 5);
  }
  return bytes;
}

// Quantized snapshot helper used by the verifier to reconstruct authority state.
export function authoritativeStatesAt(config, tick) {
  const sim = new LabSim(config);
  for (let i = 0; i < tick; i++) sim.step();
  return sim.states();
}

export { quantizePosition, quantizeRotation };
