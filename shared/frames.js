// Client-side frame intake. Nothing here mutates the renderable world until a
// complete, verified frame has been installed atomically.

import {
  ByteReader, decodeStateRecord, digest8, equalDigest, worldDigest,
  toHex, HASH_BYTES, RECORD,
} from './wire.js';
import { decodeTileHeader, Assembly } from './packets.js';
import { FRAME_KIND, FRAME_HEADER_BYTES } from './lab.js';

export function parseFramePayload(payload) {
  const r = new ByteReader(payload);
  const tick = r.u32();
  const seq = r.u32();
  const baseTick = r.u32();
  const kind = r.u8();
  const liveCount = r.u32();
  const recordCount = r.u32();
  const baseDigest = new Uint8Array(r.bytes(HASH_BYTES));
  if (kind !== FRAME_KIND.DELTA && kind !== FRAME_KIND.CHECKPOINT) {
    throw new RangeError(`unknown frame kind ${kind}`);
  }
  if (kind === FRAME_KIND.CHECKPOINT && baseTick !== 0) {
    throw new RangeError('checkpoint frame claims a baseline');
  }
  if (recordCount > payload.length) throw new RangeError('record count exceeds payload size');
  return { tick, seq, baseTick, kind, liveCount, recordCount, baseDigest };
}

// Decode every record against the baseline that the frame names. The record id
// is read before its baseline lookup, so a delta against an object the client
// does not hold is reported instead of silently reconstructed.
export function decodeRecordsWithBaseline(payload, header, baseMap) {
  const r = new ByteReader(payload.subarray(FRAME_HEADER_BYTES));
  const records = [];
  let baseMissing = 0;
  let lastId = -1;
  for (let i = 0; i < header.recordCount; i++) {
    const start = r.pos;
    const id = r.u32();
    if (id <= lastId) throw new RangeError('records must be strictly increasing by id');
    lastId = id;
    r.pos = start;
    const rec = decodeStateRecord(r, baseMap.get(id));
    if (rec.baseMissing) baseMissing++;
    records.push(rec);
  }
  r.expectEnd();
  return { records, baseMissing };
}

// Validate a fully assembled frame against the client's installed state and
// retained, verified baselines. Returns { ok, install } on success.
export function validateAndApplyFrame({
  payload, frameHeader, baselines, installedTick, installedDigest,
}) {
  let parsed;
  try {
    parsed = parseFramePayload(payload);
  } catch (err) {
    return fail(`frame parse failed: ${err.message}`);
  }
  if (parsed.tick !== frameHeader.tick) return fail('tick disagrees with packet header');
  if (parsed.seq !== frameHeader.seq) return fail('seq disagrees with packet header');
  if (parsed.kind !== frameHeader.kind) return fail('kind disagrees with packet header');

  let baseMap = null;
  if (parsed.kind === FRAME_KIND.CHECKPOINT) {
    if (parsed.baseTick !== 0) return fail('checkpoint must not reference a baseline');
    if (parsed.recordCount === 0 && parsed.liveCount > 0) {
      return fail('checkpoint carries no records but claims live objects');
    }
    baseMap = new Map();
  } else {
    if (!Number.isInteger(parsed.baseTick) || parsed.baseTick <= 0) {
      return fail('delta without a baseline tick', true);
    }
    const base = baselines.get(parsed.baseTick);
    if (!base) return fail(`no retained baseline for tick ${parsed.baseTick}`, true);
    if (!equalDigest(parsed.baseDigest, base.digest)) {
      return fail(`baseline digest mismatch at tick ${parsed.baseTick}`, true);
    }
    // A delta must build on something already installed; baselines only ever
    // contain fully installed states, so this is the anti-half-frame guard.
    if (parsed.baseTick > installedTick) {
      return fail(`baseline tick ${parsed.baseTick} is newer than installed ${installedTick}`, true);
    }
    baseMap = base.states;
  }

  let decoded;
  try {
    decoded = decodeRecordsWithBaseline(payload, parsed, baseMap);
  } catch (err) {
    return fail(`record decode failed: ${err.message}`, true);
  }
  if (decoded.baseMissing > 0) {
    return fail(`${decoded.baseMissing} records reference objects absent from the baseline`, true);
  }

  const next = new Map(baseMap);
  for (const rec of decoded.records) {
    if (rec.state.alive) next.set(rec.id, rec.state);
    else next.delete(rec.id);
  }

  let live = 0;
  for (const s of next.values()) if (s.alive) live++;
  if (live !== parsed.liveCount) {
    return fail(`live count ${live} disagrees with declared ${parsed.liveCount}`);
  }
  const digest = worldDigest(next);
  return {
    ok: true,
    install: { tick: parsed.tick, seq: parsed.seq, baseTick: parsed.baseTick, states: next, digest },
  };

  function fail(reason, requestCheckpoint = false) {
    return { ok: false, reason, requestCheckpoint, tick: parsed ? parsed.tick : null, seq: parsed ? parsed.seq : null };
  }
}

// A whole-frame intake object: feed tiles in any order, drop any of them.
export class FrameCollector {
  constructor({ sessionId, onFrame, onReject, onProgress, now = () => Date.now() }) {
    this.sessionId = sessionId;
    this.onFrame = onFrame;
    this.onReject = onReject || (() => {});
    this.onProgress = onProgress || (() => {});
    this.now = now;
    this.frames = new Map();
    this.stats = { packets: 0, bytes: 0, badPackets: 0, framesSeen: 0, framesCompleted: 0, framesAborted: 0 };
    this.maxBufferedBytes = 0;
    this.bufferedBytes = 0;
  }

  ingest(bytes) {
    let hdr;
    try {
      hdr = decodeTileHeader(bytes);
    } catch (err) {
      this.stats.badPackets++;
      this.onReject({ stage: 'packet', reason: err.message });
      return;
    }
    if (hdr.sessionId !== this.sessionId) {
      this.stats.badPackets++;
      this.onReject({ stage: 'packet', reason: 'wrong session id' });
      return;
    }
    hdr.receivedAt = this.now();
    this.stats.packets++;
    this.stats.bytes += bytes.length;
    let slot = this.frames.get(hdr.frameId);
    if (!slot) {
      slot = { assembly: new Assembly(), header: hdr, startedAt: hdr.receivedAt };
      this.frames.set(hdr.frameId, slot);
      this.stats.framesSeen++;
    }
    if (slot.header.count !== hdr.count || slot.header.tick !== hdr.tick ||
        slot.header.seq !== hdr.seq || slot.header.kind !== hdr.kind ||
        slot.header.totalLen !== hdr.totalLen || slot.header.nonce !== hdr.nonce) {
      this.stats.badPackets++;
      this.onReject({ stage: 'packet', reason: 'frame metadata changed between tiles' });
      return;
    }
    let res;
    try {
      res = slot.assembly.add(hdr);
    } catch (err) {
      this.stats.badPackets++;
      this.onReject({ stage: 'packet', reason: err.message });
      return;
    }
    if (res.duplicate) return;
    this.bufferedBytes += hdr.partLen;
    this.maxBufferedBytes = Math.max(this.maxBufferedBytes, this.bufferedBytes);
    this.onProgress({ frameId: hdr.frameId, received: slot.assembly.received, count: hdr.count });
    if (!res.complete) return;
    let payload;
    try {
      payload = slot.assembly.assemble();
    } catch (err) {
      this.stats.framesAborted++;
      this.bufferedBytes -= slot.assembly.bytes;
      this.frames.delete(hdr.frameId);
      this.onReject({ stage: 'assemble', frameId: hdr.frameId, reason: err.message });
      return;
    }
    this.stats.framesCompleted++;
    this.bufferedBytes -= slot.assembly.bytes;
    this.frames.delete(hdr.frameId);
    this.onFrame({ payload, header: slot.header, assembly: slot.assembly });
  }

  // Discard frames that can never become the next install: the client only
  // ever accepts the frame whose baseline is its installed tick, so anything
  // far behind the newest in-flight sequence is dead weight.
  dropStale(maxBehind, keepSeq) {
    const seqs = [...this.frames.values()].map(s => s.header.seq);
    if (seqs.length === 0) return 0;
    const newest = Math.max(...seqs);
    let dropped = 0;
    for (const [frameId, slot] of [...this.frames]) {
      const seq = slot.header.seq;
      if (keepSeq != null && seq >= keepSeq) continue;
      if (newest - seq < maxBehind) continue;
      this.dropFrame(frameId);
      dropped++;
    }
    return dropped;
  }

  dropFrame(frameId) {
    const slot = this.frames.get(frameId);
    if (!slot) return false;
    this.stats.framesAborted++;
    this.bufferedBytes -= slot.assembly.bytes;
    this.frames.delete(frameId);
    return true;
  }

  reset() {
    this.frames.clear();
    this.bufferedBytes = 0;
  }
}

