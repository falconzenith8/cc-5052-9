// Fragmentation and reassembly of one frame across simulated UDP tiles.
//
// Packet header (little-endian), offsets in bytes:
//   0  u8   magic 0x4f
//   1  u8   protocol version
//   2  u32  session id
//   6  u32  frame id
//  10  u32  tick
//  14  u32  seq
//  18  u32  nonce
//  22  u8   frame kind (1 delta, 2 checkpoint)
//  23  u32  tile index
//  27  u32  tile count
//  31  u32  payload bytes in this tile
//  35  u32  total payload bytes in the frame
//  39  u8[8] frame digest
//  47  u32  tile CRC32 (FNV-1a 32) over this tile's payload
//  51  payload
export const PACKET_HEADER_BYTES = 51;
export const PACKET_MAGIC = 0x4f;

import {
  ByteWriter, ByteReader, fnv1a32, digest8, equalDigest,
  PROTOCOL_VERSION, TILE_BYTES, MAX_TILES,
} from './wire.js';

export function encodeTiles({ sessionId, frameId, tick, seq, nonce, kind, payload }) {
  const count = Math.max(1, Math.ceil(payload.length / TILE_BYTES));
  if (count > MAX_TILES) throw new Error(`frame too large to fragment: ${count} tiles`);
  const frameDigest = digest8(payload);
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const start = i * TILE_BYTES;
    const part = payload.subarray(start, Math.min(start + TILE_BYTES, payload.length));
    const w = new ByteWriter(PACKET_HEADER_BYTES + part.length);
    w.u8(PACKET_MAGIC);
    w.u8(PROTOCOL_VERSION);
    w.u32(sessionId);
    w.u32(frameId);
    w.u32(tick);
    w.u32(seq);
    w.u32(nonce);
    w.u8(kind);
    w.u32(i);
    w.u32(count);
    w.u32(part.length);
    w.u32(payload.length);
    w.bytes(frameDigest);
    w.u32(fnv1a32(part));
    w.bytes(part);
    tiles.push(w.finish());
  }
  return { tiles, frameDigest, count };
}

export function decodeTileHeader(bytes) {
  const r = new ByteReader(bytes);
  const magic = r.u8();
  if (magic !== PACKET_MAGIC) throw new RangeError('not a lab packet');
  const version = r.u8();
  if (version !== PROTOCOL_VERSION) throw new RangeError(`protocol mismatch ${version}`);
  const sessionId = r.u32();
  const frameId = r.u32();
  const tick = r.u32();
  const seq = r.u32();
  const nonce = r.u32();
  const kind = r.u8();
  const index = r.u32();
  const count = r.u32();
  const partLen = r.u32();
  const totalLen = r.u32();
  const frameDigest = new Uint8Array(r.bytes(8));
  const crc = r.u32();
  if (r.pos !== PACKET_HEADER_BYTES) throw new RangeError('header layout drift');
  if (bytes.length !== PACKET_HEADER_BYTES + partLen) {
    throw new RangeError('packet length disagrees with header');
  }
  if (count === 0 || count > MAX_TILES || index >= count) {
    throw new RangeError('packet tile index out of range');
  }
  if (partLen > TILE_BYTES) throw new RangeError('tile larger than tile budget');
  if (index < count - 1 && partLen !== TILE_BYTES) throw new RangeError('non-final tile short');
  if (totalLen > MAX_TILES * TILE_BYTES) throw new RangeError('declared frame size out of range');
  if (index === count - 1) {
    if (totalLen !== (count - 1) * TILE_BYTES + partLen) {
      throw new RangeError('declared frame size disagrees with final tile');
    }
  } else if (partLen !== TILE_BYTES ||
             totalLen <= (count - 1) * TILE_BYTES ||
             totalLen > count * TILE_BYTES) {
    throw new RangeError('declared frame size disagrees with tile count');
  }
  const part = new Uint8Array(r.bytes(partLen));
  if (bytes.length < PACKET_HEADER_BYTES) throw new RangeError('packet shorter than header');
  if (fnv1a32(part) !== crc) throw new RangeError('tile CRC mismatch');
  return {
    sessionId, frameId, tick, seq, nonce, kind, index, count, partLen, totalLen,
    frameDigest, payloadPart: part,
  };
}

// Reassembly buffer for one frame. The frame is assembled only when every tile
// is present; assemble() re-checks the digest over the joined payload.
export class Assembly {
  constructor() {
    this.expected = 0;
    this.parts = new Map();
    this.received = 0;
    this.totalLen = -1;
    this.frameDigest = null;
    this.duplicates = 0;
    this.bytes = 0;
    this.order = [];
    this.startedAt = 0;
  }

  add(header) {
    if (this.expected === 0) {
      this.expected = header.count;
      this.totalLen = header.totalLen;
      this.frameDigest = header.frameDigest;
      this.startedAt = header.receivedAt ?? 0;
    }
    if (header.totalLen !== this.totalLen) throw new Error('frame total length changed mid-frame');
    if (!equalDigest(header.frameDigest, this.frameDigest)) throw new Error('frame digest changed mid-frame');
    if (this.parts.has(header.index)) { this.duplicates++; return { complete: this.complete }; }
    this.parts.set(header.index, header.payloadPart);
    this.received++;
    this.bytes += header.partLen;
    this.order.push(header.index);
    return { complete: this.complete };
  }

  get complete() { return this.expected > 0 && this.received === this.expected; }

  assemble() {
    if (!this.complete) throw new Error(`frame incomplete: ${this.received}/${this.expected}`);
    const out = new Uint8Array(this.totalLen);
    let off = 0;
    for (let i = 0; i < this.expected; i++) {
      const part = this.parts.get(i);
      if (!part) throw new Error(`missing tile ${i}`);
      if (off + part.length > out.length) throw new Error('tiles overrun declared frame length');
      out.set(part, off);
      off += part.length;
    }
    if (off !== this.totalLen) throw new Error('assembled length disagrees with header');
    if (!equalDigest(digest8(out), this.frameDigest)) throw new Error('frame digest mismatch');
    return out;
  }
}
