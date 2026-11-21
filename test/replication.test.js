import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthoritativeLink } from '../shared/link.js';
import { LabSim } from '../shared/lab.js';
import { worldDigest, toHex } from '../shared/wire.js';

function withOracle(link) {
  const oracle = new LabSim(link.config);
  const snapshots = new Map([[0, oracle.states()]]);
  const checks = [];
  link.client.onInstall = (e) => {
    while (oracle.tick < e.tick) { oracle.step(); snapshots.set(oracle.tick, oracle.states()); }
    checks.push({
      tick: e.tick,
      kind: e.kind,
      ok: toHex(worldDigest(snapshots.get(e.tick))) === toHex(e.digest),
    });
  };
  return checks;
}

test('clean link converges and every install matches the authority replay', () => {
  const link = new AuthoritativeLink({ impairment: {}, seed: 3 });
  const checks = withOracle(link);
  link.run(300);
  assert.ok(checks.length > 50, `installed ${checks.length} frames`);
  assert.deepEqual(checks.filter(c => !c.ok), []);
  // The client always lags the authority by at least one tick: acks are only
  // written after install, so the next frame is built one tick later.
  assert.ok(link.authority.sim.tick - link.client.tick >= 1,
    `client t${link.client.tick} lags authority t${link.authority.sim.tick}`);
});

test('slow acks, reordering and periodic middle-tile loss still converge', () => {
  const link = new AuthoritativeLink({
    impairment: { latencyMs: 80, jitterMs: 50, reorder: true, dropMiddleEveryFrames: 4, ackDelayMs: 700 },
    seed: 19,
  });
  const checks = withOracle(link);
  link.run(800);
  assert.ok(checks.length > 20);
  assert.deepEqual(checks.filter(c => !c.ok), []);
  assert.ok(link.client.recoveryLog.length > 0, 'a middle-tile loss forced at least one recovery');
});

test('the client never installs a frame it did not fully verify', () => {
  const link = new AuthoritativeLink({
    impairment: { latencyMs: 0, reorder: true, dropMiddleEveryFrames: 2 },
    seed: 5,
  });
  const installed = [];
  link.client.onInstall = (e) => installed.push(e);
  link.run(200);
  for (const e of installed) assert.ok(e.digest, 'install carries a verified digest');
  // Every install tick must be strictly newer than the previous one.
  for (let i = 1; i < installed.length; i++) {
    assert.ok(installed[i].tick > installed[i - 1].tick, 'installed ticks advance');
  }
});

test('no half-received frame is ever a baseline', () => {
  const link = new AuthoritativeLink({
    impairment: { latencyMs: 30, reorder: true, dropMiddleEveryFrames: 3 },
    seed: 9,
  });
  link.run(400);
  // Every retained client baseline must correspond to an actual install.
  const installedTicks = new Set(link.installHistory.map(i => i.tick));
  for (const e of link.client.baselines.entries) {
    if (e.tick === 0) continue;
    assert.ok(installedTicks.has(e.tick), `baseline t${e.tick} was never installed`);
  }
});

test('recovery strategy uses an older common baseline before a checkpoint', () => {
  const link = new AuthoritativeLink({
    impairment: { latencyMs: 80, jitterMs: 40, reorder: true, dropMiddleEveryFrames: 3, ackDelayMs: 500 },
    seed: 13,
  });
  link.run(700);
  const deltaRecoveries = link.client.recoveryLog.filter(r => r.installedKind === 'delta');
  assert.ok(deltaRecoveries.length > 0, 'at least one recovery resumed from a cheaper-than-checkpoint delta');
});

test('a forced checkpoint is honoured even when a delta would be cheap', () => {
  const link = new AuthoritativeLink({ impairment: {}, seed: 2 });
  link.run(40);
  link.authority.requestCheckpoint('test');
  const before = link.authority.framesSentByKind.checkpoint;
  link.run(30);
  assert.ok(link.authority.framesSentByKind.checkpoint > before, 'authority sent a checkpoint on request');
});

test('installs report the baseline they were actually built from', () => {
  const link = new AuthoritativeLink({
    impairment: { latencyMs: 60, reorder: true, dropMiddleEveryFrames: 4, ackDelayMs: 300 },
    seed: 11,
  });
  const installs = [];
  link.client.onInstall = (e) => installs.push(e);
  link.run(400);
  assert.ok(installs.length > 10);
  const [first, ...rest] = installs;
  assert.equal(first.kind, 'checkpoint', 'the first install must be a checkpoint');
  assert.equal(first.baseTick, 0, 'a checkpoint has no baseline tick');
  for (const e of rest) {
    if (e.kind === 'checkpoint') {
      assert.equal(e.baseTick, 0, `checkpoint at t${e.tick} must not claim a baseline`);
    } else {
      assert.ok(e.baseTick > 0 && e.baseTick < e.tick,
        `delta at t${e.tick} must reference an older baseline, got ${e.baseTick}`);
    }
  }
});

test('an ack quoting a digest the authority never sent is rejected', () => {
  const link = new AuthoritativeLink({ impairment: {}, seed: 2 });
  link.run(30);
  const seq = link.authority.seq;
  const res = link.authority.acceptAck({
    protocol: 1, sessionId: 1, seq, tick: link.client.tick,
    digest: new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]), nonce: 1, budget: null,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /digest|nonce/);
});
