import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quantizePosition, dequantizePosition, quantizeRotation, dequantizeRotation,
  worldDigest, canonicalWorldState, encodeStateRecord, decodeStateRecord,
  ByteReader, QUANT, stateFromFloat, FIELD,
} from '../shared/wire.js';

test('position quantization respects bounds and round-trips within a step', () => {
  for (const v of [-300, -12.37, 0, 7.8, 255.99, 400]) {
    const q = quantizePosition(v);
    assert.ok(q >= QUANT.positionMin && q <= QUANT.positionMax, `${v} -> ${q}`);
    const back = dequantizePosition(q);
    assert.ok(Math.abs(back - Math.max(-256, Math.min(256, v))) <= QUANT.positionStep, `${v} -> ${back}`);
  }
});

test('rotation quantization wraps into one turn', () => {
  for (const r of [-7.5, 0, 0.1, Math.PI, 2 * Math.PI * 3 + 1.2]) {
    const q = quantizeRotation(r);
    assert.ok(Number.isInteger(q) && q >= 0 && q < QUANT.rotLevels);
    const d = dequantizeRotation(q);
    assert.ok(d >= 0 && d < Math.PI * 2 + 1e-9);
  }
});

test('full record round-trips identity and fields', () => {
  const s = stateFromFloat({ x: 12.5, y: -8.25, rot: 1.1, on: 1, label: 'M07', kind: 'moving' });
  const bytes = encodeStateRecord(42, s, null);
  const rec = decodeStateRecord(new ByteReader(bytes), undefined);
  assert.equal(rec.baseMissing, false);
  assert.equal(rec.id, 42);
  assert.deepEqual(rec.state, s);
});

test('delta only carries changed fields', () => {
  const base = stateFromFloat({ x: 1, y: 2, rot: 0, on: 0, label: 'A', kind: 'stationary' });
  const next = { ...base, px: base.px + 1 };
  const bytes = encodeStateRecord(7, next, base);
  assert.equal(bytes.length, 5 + 2, 'id + header + one field');
  const rec = decodeStateRecord(new ByteReader(bytes), base);
  assert.equal(rec.state.px, base.px + 1);
  assert.equal(rec.state.py, base.py);
});

test('delta against a missing baseline reports baseMissing, never guesses', () => {
  const base = stateFromFloat({ x: 1, y: 2, rot: 0, on: 0, label: 'A', kind: 'stationary' });
  const bytes = encodeStateRecord(7, { ...base, px: base.px + 3 }, base);
  const rec = decodeStateRecord(new ByteReader(bytes), undefined);
  assert.equal(rec.baseMissing, true);
  assert.equal(rec.state, null);
});

test('destroy record carries no field payload', () => {
  const base = stateFromFloat({ x: 1, y: 2, rot: 0, on: 1, label: 'T', kind: 'transient' });
  const bytes = encodeStateRecord(9, { ...base, alive: 0 }, base);
  assert.equal(bytes.length, 5);
  const rec = decodeStateRecord(new ByteReader(bytes), base);
  assert.equal(rec.state.alive, 0);
  assert.equal(decodeStateRecord(new ByteReader(bytes), undefined).baseMissing, true);
});

test('world digest is order-independent and sensitive to every field', () => {
  const a = stateFromFloat({ x: 1, y: 2, rot: 0, on: 1, label: 'A', kind: 'stationary' });
  const b = stateFromFloat({ x: 3, y: 4, rot: 0.5, on: 0, label: 'B', kind: 'moving' });
  const m1 = new Map([[1, a], [2, b]]);
  const m2 = new Map([[2, b], [1, a]]);
  assert.deepEqual(worldDigest(m1), worldDigest(m2));
  assert.notDeepEqual(worldDigest(m1), worldDigest(new Map([[1, a], [2, { ...b, on: 1 }]])));
  assert.notDeepEqual(worldDigest(m1), worldDigest(new Map([[1, { ...a, label: 'Z' }], [2, b]])));
  assert.notDeepEqual(worldDigest(m1), worldDigest(new Map([[1, { ...a, rot: 9 }], [2, b]])));
});

test('canonical state excludes dead entries', () => {
  const a = stateFromFloat({ x: 1, y: 2, rot: 0, on: 1, label: 'A', kind: 'stationary' });
  const list = canonicalWorldState(new Map([[1, a], [2, { ...a, alive: 0 }]]));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 1);
});

test('field bits are the documented ones', () => {
  assert.equal(FIELD.PX, 1);
  assert.equal(FIELD.PY, 2);
  assert.equal(FIELD.ROT, 4);
  assert.equal(FIELD.ON, 8);
});
