import test from 'node:test';
import assert from 'node:assert/strict';
import { BaselineStore, baselineBytesFor, SnapshotRing, countLive } from '../shared/lab.js';
import { stateFromFloat, worldDigest } from '../shared/wire.js';

function states(n, offset = 0) {
  const m = new Map();
  for (let i = 0; i < n; i++) {
    m.set(i, stateFromFloat({ x: i + offset, y: -i, rot: 0, on: 1, label: `o${i}`, kind: 'stationary' }));
  }
  return m;
}

test('baseline bytes are charged consistently', () => {
  const st = states(10);
  assert.equal(baselineBytesFor(countLive(st)), baselineBytesFor(10));
  assert.equal(baselineBytesFor(10) - baselineBytesFor(9), 11);
});

test('store never exceeds its byte budget', () => {
  const budget = baselineBytesFor(20) * 2 + 5;
  const store = new BaselineStore(budget);
  for (let t = 1; t <= 40; t++) store.put(t, states(20, t), worldDigest(states(20, t)));
  assert.ok(store.bytes <= budget, `${store.bytes} <= ${budget}`);
  assert.ok(store.peakBytes <= budget);
});

test('a pinned baseline outranks newer speculative snapshots', () => {
  const budget = baselineBytesFor(20) * 2;
  const store = new BaselineStore(budget);
  const pinned = states(20);
  const pinDigest = worldDigest(pinned);
  store.put(5, pinned, pinDigest);
  store.addPin(5, 3);
  for (let t = 6; t < 40; t++) store.put(t, states(20, t), worldDigest(states(20, t)));
  assert.ok(store.get(5), 'confirmed baseline survived 34 newer snapshots');
  assert.equal(store.get(5).digest, pinDigest);
});

test('a confirmed and an in-flight baseline both fit the small budget', () => {
  const budget = baselineBytesFor(20) * 2;
  const store = new BaselineStore(budget);
  store.put(10, states(20, 1));
  store.put(11, states(20, 2));
  store.addPin(10, 3);
  store.addPin(11, 2);
  store.put(12, states(20, 3));
  store.put(13, states(20, 4));
  assert.ok(store.get(10), 'confirmed pin kept');
  assert.ok(store.get(11), 'in-flight pin kept');
  assert.ok(store.bytes <= budget);
});

test('when a pinned entry alone exceeds the budget it is dropped honestly', () => {
  const store = new BaselineStore(100);
  store.put(1, states(50));
  assert.equal(store.get(1), null, 'an oversized snapshot is never stored');
  store.addPin(1, 3);
  assert.equal(store.get(1), null);
  assert.equal(store.bytes, 0);
});

test('unpinned eviction frees budget without touching pins', () => {
  const budget = baselineBytesFor(20) * 3;
  const store = new BaselineStore(budget);
  for (let t = 1; t <= 8; t++) store.put(t, states(20, t));
  store.addPin(store.entries[0].tick, 3);
  const pinnedTick = store.entries[0].tick;
  store.evictUnpinned(0);
  assert.ok(store.get(pinnedTick));
  assert.ok(store.bytes <= budget);
});

test('newestCommon requires matching tick and digest', () => {
  const store = new BaselineStore(1 << 20);
  const s1 = states(3, 0), s2 = states(3, 1);
  store.put(10, s1, worldDigest(s1));
  store.put(20, s2, worldDigest(s2));
  const common = store.newestCommon([
    { tick: 10, digest: Buffer.from(worldDigest(s1)).toString('hex') },
    { tick: 20, digest: 'ffffffffffffffff' },
  ], 25);
  assert.equal(common.tick, 10, 'tick 20 was rejected for digest mismatch');
});

test('rolling ring is bounded by tick count and cheap to read', () => {
  const ring = new SnapshotRing(1 << 20, 8);
  for (let t = 0; t < 30; t++) ring.put(t, states(5), new Uint8Array(8));
  assert.equal(ring.order.length, 8);
  assert.equal(ring.get(29).tick, 29);
  assert.equal(ring.get(0), null);
});
