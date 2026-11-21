import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthoritativeLink } from '../shared/link.js';
import { auditReport, replayAuthority } from '../tools/verify.mjs';
import { buildAudit } from '../tools/audit-run.mjs';

test('headless audit reproduces the authority and passes every check', () => {
  const report = buildAudit({
    steps: 700,
    impairment: { latencyMs: 70, jitterMs: 40, reorder: true, dropMiddleEveryFrames: 5, ackDelayMs: 500 },
    trackedId: 1001,
    seed: 21,
  });
  assert.equal(report.audit.ok, true, JSON.stringify(report.audit.failures));
  assert.ok(report.audit.checkedInstalls > 30);
  assert.ok(report.installs.length > 30);
  assert.ok(report.audit.peaks.clientBaselineBytes <= report.audit.peaks.budgetBytes);
});

test('audit catches a tampered install digest', () => {
  const report = buildAudit({
    steps: 300,
    impairment: { latencyMs: 40, reorder: true, dropMiddleEveryFrames: 6, ackDelayMs: 300 },
    seed: 4,
  });
  const tampered = JSON.parse(JSON.stringify(report));
  tampered.installs[Math.floor(tampered.installs.length / 2)].digest = '0000000000000000';
  const result = auditReport(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => /digest/.test(f)), result.failures.join('; '));
});

test('audit catches an object the client saw before the authority created it', () => {
  const report = buildAudit({
    steps: 400,
    impairment: {},
    trackedId: 1001,
    seed: 8,
  });
  const tampered = JSON.parse(JSON.stringify(report));
  if (tampered.tracked) {
    tampered.tracked.lifecycle = [{ tick: 0, event: 'appeared', detail: 'fabricated' }];
    tampered.tracked.id = 5001; // first transient, created much later
    const result = auditReport(tampered);
    assert.equal(result.ok, false);
  }
});

test('audit flags a client baseline that exceeds the declared budget', () => {
  const report = buildAudit({ steps: 120, impairment: {}, seed: 1 });
  const tampered = JSON.parse(JSON.stringify(report));
  tampered.peak.clientBaselineBytes = 10_000_000;
  const result = auditReport(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => /budget/.test(f)));
});

test('audit counts checkpoints and deltas by installed kind', () => {
  const report = buildAudit({
    steps: 400,
    impairment: { latencyMs: 60, reorder: true, dropMiddleEveryFrames: 3, ackDelayMs: 500 },
    seed: 7,
  });
  assert.ok(report.audit.checkpoints > 0, 'a harsh link must force at least one checkpoint');
  assert.ok(report.audit.deltas > 0, 'cheap resumptions must still use deltas');
  assert.equal(report.installs[0].kind, 'checkpoint');
  assert.equal(report.installs[0].baseTick, 0);
  const deltas = report.installs.filter(i => i.kind === 'delta');
  assert.ok(deltas.every(d => d.baseTick > 0 && d.baseTick < d.tick),
    'every recorded delta names an older baseline');
  const checkpoints = report.installs.filter(i => i.kind === 'checkpoint');
  assert.ok(checkpoints.every(c => !c.baseTick), 'no checkpoint claims a baseline');
});

test('audit rejects a delta that names a baseline newer than itself', () => {
  const report = buildAudit({ steps: 200, impairment: {}, seed: 3 });
  const tampered = JSON.parse(JSON.stringify(report));
  const delta = tampered.installs.find(i => i.kind === 'delta');
  delta.baseTick = delta.tick + 5;
  const result = auditReport(tampered);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(f => /baseline/.test(f)), result.failures.join('; '));
});

test('replayAuthority is deterministic for a seed', () => {
  const config = { seed: 77, stationary: 30, moving: 4, pulser: 4, transientCap: 2 };
  const a = replayAuthority(config, 120);
  const b = replayAuthority(config, 120);
  const idsA = [...a.get(120).keys()].sort((x, y) => x - y);
  const idsB = [...b.get(120).keys()].sort((x, y) => x - y);
  assert.deepEqual(idsA, idsB);
  for (const id of idsA) assert.deepEqual(a.get(120).get(id), b.get(120).get(id));
});
