import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTiles, decodeTileHeader, Assembly } from '../shared/packets.js';
import { TILE_BYTES } from '../shared/wire.js';

function makeTiles(payloadLen = 600) {
  const payload = new Uint8Array(payloadLen);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
  return encodeTiles({ sessionId: 3, frameId: 11, tick: 42, seq: 4, nonce: 99, kind: 1, payload });
}

test('tiles round-trip through the header and reassemble byte-exact', () => {
  const { tiles } = makeTiles(3 * TILE_BYTES + 17);
  assert.equal(tiles.length, 4);
  const asm = new Assembly();
  for (const t of tiles) asm.add(decodeTileHeader(t));
  assert.equal(asm.complete, true);
  const out = asm.assemble();
  assert.equal(out.length, 3 * TILE_BYTES + 17);
  for (let i = 0; i < out.length; i++) assert.equal(out[i], (i * 31) & 0xff);
});

test('out-of-order arrival still reassembles', () => {
  const { tiles } = makeTiles(2000);
  const asm = new Assembly();
  const order = tiles.map((_, i) => i).reverse();
  for (const i of order) asm.add(decodeTileHeader(tiles[i]));
  assert.equal(asm.complete, true);
  assert.equal(asm.assemble().length, 2000);
});

test('a missing middle tile prevents assembly', () => {
  const { tiles } = makeTiles(3000);
  const asm = new Assembly();
  const mid = Math.floor(tiles.length / 2);
  tiles.forEach((t, i) => { if (i !== mid) asm.add(decodeTileHeader(t)); });
  assert.equal(asm.complete, false);
  assert.throws(() => asm.assemble(), /incomplete/);
});

test('corrupted tile payload is rejected by the tile CRC', () => {
  const { tiles } = makeTiles(1500);
  const bad = Uint8Array.from(tiles[0]);
  bad[bad.length - 1] ^= 0xff;
  assert.throws(() => decodeTileHeader(bad), /CRC/);
});

test('a frame digest that disagrees between tiles is rejected', () => {
  const { tiles } = makeTiles(1500);
  const headers = tiles.map(decodeTileHeader);
  const asm = new Assembly();
  asm.add(headers[0]);
  assert.throws(() => asm.add({ ...headers[1], frameDigest: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }), /digest changed/);
});

test('a payload that does not match its declared frame digest is caught at assemble', () => {
  const { tiles } = makeTiles(1500);
  const asm = new Assembly();
  // All tiles agree on the header, but the payload never hashes to that digest.
  const headers = tiles.map(decodeTileHeader);
  const fake = headers.map(h => ({ ...h, frameDigest: new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7]) }));
  for (const h of fake) asm.add(h);
  assert.equal(asm.complete, true);
  assert.throws(() => asm.assemble(), /frame digest mismatch/);
});

test('tile metadata cannot change mid-frame', () => {
  const { tiles } = makeTiles(2000);
  const h0 = decodeTileHeader(tiles[0]);
  const h1 = decodeTileHeader(tiles[1]);
  const asm = new Assembly();
  asm.add(h0);
  assert.throws(() => asm.add({ ...h1, totalLen: h1.totalLen + 1 }), /total length changed/);
});

test('duplicate tiles are counted, not double-installed', () => {
  const { tiles } = makeTiles(1500);
  const asm = new Assembly();
  asm.add(decodeTileHeader(tiles[0]));
  asm.add(decodeTileHeader(tiles[0]));
  assert.equal(asm.received, 1);
  assert.equal(asm.duplicates, 1);
});
