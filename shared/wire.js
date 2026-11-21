// Wire format shared by server and client. Everything on the wire is built
// from typed arrays so the client can verify bytes it does not trust.

export const PROTOCOL_VERSION = 1;
export const TILE_BYTES = 96;            // payload budget of one simulated UDP tile
export const MAX_TILES = 20000;          // arithmetic bound; rejects absurd headers
export const HASH_BYTES = 8;             // FNV-1a 64 digest
export const SNAPSHOT_EVERY_TICKS = 10;

export const KIND = Object.freeze({ STATIONARY: 0, MOVING: 1, TRANSIENT: 2, PULSER: 3 });
export const KIND_NAME = ['stationary', 'moving', 'transient', 'pulser'];

// Wire field bits for a delta record. A zero bit means "equals baseline",
// never "unchanged since the previous frame".
export const FIELD = Object.freeze({
  PX: 1 << 0,
  PY: 1 << 1,
  ROT: 1 << 2,
  ON: 1 << 3,
});
export const FIELD_NAMES = ['px', 'py', 'rot', 'on'];

export const QUANT = Object.freeze({
  positionStep: 0.125,   // world units per quant level
  positionLevels: 4096,  // 12-bit signed level range
  positionMin: -2048,
  positionMax: 2047,
  rotLevels: 65536,      // 16-bit full turn
});

// ---------------------------------------------------------------------------
// Binary writer / reader (DataView based, explicit little-endian)

export class ByteWriter {
  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  _need(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v) { this._need(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v) { this._need(2); this.view.setUint16(this.pos, v & 0xffff, true); this.pos += 2; }
  u32(v) { this._need(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  bytes(arr) { this._need(arr.length); this.buf.set(arr, this.pos); this.pos += arr.length; }
  finish() { return this.buf.subarray(0, this.pos); }
  get length() { return this.pos; }
}

export class ByteReader {
  constructor(bytes) {
    this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = 0;
  }
  _need(n) {
    if (this.pos + n > this.buf.length) {
      throw new RangeError(`truncated payload: need ${n} at ${this.pos}, have ${this.buf.length}`);
    }
  }
  u8() { this._need(1); const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  u16() { this._need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this._need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  bytes(n) { this._need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  get remaining() { return this.buf.length - this.pos; }
  expectEnd() {
    if (this.remaining !== 0) throw new RangeError(`trailing bytes: ${this.remaining} unread`);
  }
}

// ---------------------------------------------------------------------------
// Checksums

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64(bytes) {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function digest8(bytes) {
  const view = new DataView(new ArrayBuffer(HASH_BYTES));
  view.setBigUint64(0, fnv1a64(bytes), true);
  return new Uint8Array(view.buffer);
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function equalDigest(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Quantization. Position is a 12-bit signed level, rotation a 16-bit turn.

export function quantizePosition(v) {
  if (!Number.isFinite(v)) throw new Error('non-finite position');
  const level = Math.round(v / QUANT.positionStep);
  return Math.max(QUANT.positionMin, Math.min(QUANT.positionMax, level));
}
export function dequantizePosition(level) { return level * QUANT.positionStep; }

export function quantizeRotation(rad) {
  if (!Number.isFinite(rad)) throw new Error('non-finite rotation');
  const turn = rad / (Math.PI * 2);
  const frac = ((turn % 1) + 1) % 1;
  return Math.round(frac * QUANT.rotLevels) % QUANT.rotLevels;
}
export function dequantizeRotation(level) { return (level / QUANT.rotLevels) * Math.PI * 2; }

export function inQuantBounds(s) {
  return Number.isInteger(s.px) && s.px >= QUANT.positionMin && s.px <= QUANT.positionMax &&
    Number.isInteger(s.py) && s.py >= QUANT.positionMin && s.py <= QUANT.positionMax &&
    Number.isInteger(s.rot) && s.rot >= 0 && s.rot < QUANT.rotLevels &&
    (s.on === 0 || s.on === 1) && (s.alive === 0 || s.alive === 1) &&
    Number.isInteger(s.kind) && s.kind >= 0 && s.kind <= 3;
}

// ---------------------------------------------------------------------------
// Object records. A record compares against a baseline state; only differences
// are serialized. Creation is a full record, destruction a dedicated kind.

export const RECORD = Object.freeze({ FULL: 0, DELTA: 1, DESTROY: 2 });
export const LABEL_BYTES = 12;

export function stateFromQuantized(q, label, kind) {
  return {
    px: q.px, py: q.py, rot: q.rot, on: q.on ? 1 : 0, alive: 1,
    label: label ?? '', kind: kind ?? 0,
  };
}

export function stateFromFloat(o) {
  return {
    px: quantizePosition(o.x), py: quantizePosition(o.y),
    rot: quantizeRotation(o.rot), on: o.on ? 1 : 0, alive: 1,
    label: o.label ?? '', kind: KIND[o.kind.toUpperCase()] ?? 0,
  };
}

export function fieldMaskFor(state, base) {
  let f = 0;
  if (state.px !== base.px) f |= FIELD.PX;
  if (state.py !== base.py) f |= FIELD.PY;
  if (state.rot !== base.rot) f |= FIELD.ROT;
  if ((state.on ? 1 : 0) !== (base.on ? 1 : 0)) f |= FIELD.ON;
  return f;
}

export const FULL_RECORD_BYTES = 4 + 1 + 2 + 2 + 2 + 1 + 1 + 1 + LABEL_BYTES;
export const DESTROY_RECORD_BYTES = 5;

export function estimateRecordBytes(state, base) {
  if (!base) return FULL_RECORD_BYTES;
  if (!state.alive) return DESTROY_RECORD_BYTES;
  const f = fieldMaskFor(state, base);
  let n = 5;
  if (f & FIELD.PX) n += 2;
  if (f & FIELD.PY) n += 2;
  if (f & FIELD.ROT) n += 2;
  if (f & FIELD.ON) n += 1;
  return n;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeLabel(w, label) {
  const bytes = encoder.encode(String(label ?? ''));
  const n = Math.min(bytes.length, LABEL_BYTES);
  w.u8(n);
  const padded = new Uint8Array(LABEL_BYTES);
  padded.set(bytes.subarray(0, n));
  w.bytes(padded);
}

function readLabel(r) {
  const n = r.u8();
  if (n > LABEL_BYTES) throw new RangeError('label length beyond wire limit');
  const raw = r.bytes(LABEL_BYTES);
  return decoder.decode(raw.subarray(0, n));
}

function signed16(v) { return v >= 0x8000 ? v - 0x10000 : v; }

function checkPosition(level, what) {
  if (level < QUANT.positionMin || level > QUANT.positionMax) {
    throw new RangeError(`${what} ${level} outside quantized position bounds`);
  }
  return level;
}

export function encodeStateRecord(id, state, base, label) {
  const w = new ByteWriter(32);
  w.u32(id);
  if (!base) {
    w.u8(RECORD.FULL);
    w.u16(state.px);
    w.u16(state.py);
    w.u16(state.rot);
    w.u8(state.on ? 1 : 0);
    w.u8(state.kind & 0x07);
    writeLabel(w, label ?? state.label ?? '');
    return w.finish();
  }
  if (!state.alive) {
    w.u8(RECORD.DESTROY);
    return w.finish();
  }
  const mask = fieldMaskFor(state, base);
  w.u8(RECORD.DELTA | (mask << 3));
  if (mask & FIELD.PX) w.u16(state.px);
  if (mask & FIELD.PY) w.u16(state.py);
  if (mask & FIELD.ROT) w.u16(state.rot);
  if (mask & FIELD.ON) w.u8(state.on ? 1 : 0);
  return w.finish();
}

// Returns { id, state, baseMissing }. baseMissing means the receiver does not
// hold the baseline this record was diffed against and must resync, not guess.
export function decodeStateRecord(r, base) {
  const id = r.u32();
  const header = r.u8();
  const kind = header & 0x07;
  const mask = header >> 3;
  if (kind === RECORD.FULL) {
    if (mask !== 0) throw new RangeError(`full record carries mask bits 0x${header.toString(16)}`);
    const px = checkPosition(signed16(r.u16()), 'px');
    const py = checkPosition(signed16(r.u16()), 'py');
    const rot = r.u16();
    const on = r.u8();
    const objKind = r.u8();
    if (on > 1) throw new RangeError('switch value outside {0,1}');
    if (objKind > 3) throw new RangeError('object kind outside wire enum');
    const label = readLabel(r);
    return { id, state: { px, py, rot, on, alive: 1, label, kind: objKind }, baseMissing: false };
  }
  if (kind === RECORD.DESTROY) {
    if (mask !== 0) throw new RangeError('destroy record carries field bits');
    if (!base) return { id, state: null, baseMissing: true };
    return { id, state: { ...base, alive: 0 }, baseMissing: false };
  }
  if (kind !== RECORD.DELTA || mask === 0) {
    throw new RangeError(`unexpected record kind ${kind} mask ${mask}`);
  }
  if (mask & ~(FIELD.PX | FIELD.PY | FIELD.ROT | FIELD.ON)) {
    throw new RangeError(`delta record carries unknown bits 0x${mask.toString(16)}`);
  }
  if (!base) return { id, state: null, baseMissing: true };
  const out = { ...base, alive: 1 };
  if (mask & FIELD.PX) out.px = checkPosition(signed16(r.u16()), 'px');
  if (mask & FIELD.PY) out.py = checkPosition(signed16(r.u16()), 'py');
  if (mask & FIELD.ROT) out.rot = r.u16();
  if (mask & FIELD.ON) {
    const on = r.u8();
    if (on > 1) throw new RangeError('switch value outside {0,1}');
    out.on = on;
  }
  return { id, state: out, baseMissing: false };
}

// ---------------------------------------------------------------------------
// Canonical world digest. Both ends and the offline verifier derive it from the
// same rule: sorted ids, quantized fields, plus identity (label + kind).

export function canonicalWorldState(states) {
  const ids = [...states.keys()].sort((a, b) => a - b);
  const list = [];
  for (const id of ids) {
    const s = states.get(id);
    if (!s || !s.alive) continue;
    list.push({
      id, px: s.px, py: s.py, rot: s.rot, on: s.on ? 1 : 0,
      kind: s.kind, label: s.label ?? '',
      labelHash: fnv1a32(encoder.encode(String(s.label ?? ''))) >>> 0,
    });
  }
  return list;
}

export function hashCanonicalWorld(canonicalList) {
  const w = new ByteWriter(64);
  w.u32(canonicalList.length);
  for (const o of canonicalList) {
    w.u32(o.id);
    w.u16(o.px & 0xffff);
    w.u16(o.py & 0xffff);
    w.u16(o.rot & 0xffff);
    w.u8(o.on ? 1 : 0);
    w.u8(o.kind);
    w.u32(o.labelHash >>> 0);
  }
  return digest8(w.finish());
}

export function worldDigest(states) {
  return hashCanonicalWorld(canonicalWorldState(states));
}
