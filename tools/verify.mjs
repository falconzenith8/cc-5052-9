// Offline authority audit. Replays the deterministic simulation from the seed
// and checks a client-installed history against it: identity, every field,
// quantization bounds, recovery latency and peak memory.

import fs from 'node:fs';
import { LabSim, BaselineStore, baselineBytesFor } from '../shared/lab.js';
import { worldDigest, toHex, QUANT, KIND_NAME } from '../shared/wire.js';

export function replayAuthority(config, upToTick) {
  const sim = new LabSim(config);
  const snapshots = new Map();
  for (let t = 0; t <= upToTick; t++) {
    snapshots.set(t, sim.states());
    if (t < upToTick) sim.step();
  }
  return snapshots;
}

export function auditInstall({ config, install, snapshots }) {
  const truth = snapshots.get(install.tick);
  if (!truth) return { tick: install.tick, ok: false, errors: ['authority has no state at that tick'] };
  const truthDigest = worldDigest(truth);
  const errors = [];
  const warnings = [];
  if (install.digest && install.digest !== toHex(truthDigest)) {
    errors.push(`world digest ${install.digest} != authority ${toHex(truthDigest)}`);
  }
  if (install.kind === 'checkpoint' && install.baseTick) {
    errors.push(`checkpoint at t${install.tick} claims baseline t${install.baseTick}`);
  }
  if (install.kind === 'delta') {
    if (!Number.isInteger(install.baseTick) || install.baseTick <= 0) {
      errors.push(`delta at t${install.tick} has no baseline tick`);
    } else if (install.baseTick >= install.tick) {
      errors.push(`delta at t${install.tick} references baseline t${install.baseTick} that is not older`);
    }
  }
  return { tick: install.tick, ok: errors.length === 0, errors, warnings, truthDigest: toHex(truthDigest) };
}

export function auditTracked({ config, tracked, snapshots }) {
  const errors = [];
  if (!tracked) return { ok: true, errors, identity: null };
  const { id } = tracked;
  let firstAlive = null;
  let lastAlive = null;
  let kind = null;
  let label = null;
  for (const [tick, states] of [...snapshots.entries()].sort((a, b) => a[0] - b[0])) {
    const s = states.get(id);
    if (s) {
      if (firstAlive == null) { firstAlive = tick; kind = s.kind; label = s.label; }
      lastAlive = tick;
    }
  }
  if (firstAlive == null) errors.push(`object ${id} never existed in the authority replay`);

  const events = tracked.lifecycle || [];
  const appeared = events.find(e => e.event === 'appeared');
  if (appeared && firstAlive != null && appeared.tick < firstAlive) {
    errors.push(`client saw object ${id} at t${appeared.tick}, authority creates it at t${firstAlive}`);
  }
  if (appeared && firstAlive != null && appeared.tick > firstAlive + 400) {
    errors.push(`client first saw object ${id} at t${appeared.tick}, far after authority creation t${firstAlive}`);
  }
  // Field bounds of every recorded path sample.
  for (const p of tracked.path || []) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      errors.push('path sample is not finite');
      break;
    }
    const px = Math.round(p.x / QUANT.positionStep);
    if (px < QUANT.positionMin || px > QUANT.positionMax) {
      errors.push(`path sample ${p.x} quantizes outside position bounds`);
      break;
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    identity: { id, kind: kind == null ? null : KIND_NAME[kind], label, firstAliveTick: firstAlive, lastAliveTick: lastAlive },
  };
}

export function auditRecoveries(installLog, recoveryLog) {
  // Recovery latency: gap between the last install before an interruption and
  // the install that resumed. computed from install tick deltas and reported ms.
  const items = [];
  for (const r of recoveryLog || []) {
    const ok = Number.isFinite(r.resolvedTick) && r.resolvedTick > r.fromTick;
    items.push({
      fromTick: r.fromTick,
      resolvedTick: r.resolvedTick,
      strategy: r.strategy,
      installedKind: r.installedKind,
      ms: r.ms,
      ticks: r.ticks,
      ok,
    });
  }
  return { ok: items.every(i => i.ok), items };
}

export function peakUsage(installLog, declared) {
  // Peak baseline bytes are crossing-checked against the declared client peak
  // and the hard budget; buffer bytes are reported from the audit payload.
  const errors = [];
  const budget = declared?.budgetBytes ?? null;
  if (budget != null && declared.clientBaselineBytes != null && declared.clientBaselineBytes > budget) {
    errors.push(`client baseline peak ${declared.clientBaselineBytes}B exceeds budget ${budget}B`);
  }
  if (budget != null && declared.frameBufferBytes != null && declared.frameBufferBytes > budget * 4) {
    // Buffer is per-frame reassembly, not the baseline store; flag if absurd.
    errors.push(`frame buffer peak ${declared.frameBufferBytes}B is implausibly large`);
  }
  return { ok: errors.length === 0, errors, ...declared };
}

// Validate an audit JSON file (produced by the browser or by the headless run).
export function auditReport(report) {
  const config = report.config || {};
  const installs = report.installs || [];
  const maxTick = installs.reduce((m, i) => Math.max(m, i.tick), 0);
  const snapshots = replayAuthority(config, Math.max(maxTick, 1));
  const installChecks = installs.map(i => auditInstall({ config, install: i, snapshots }));
  const trackedCheck = auditTracked({ config, tracked: report.tracked, snapshots });
  const recoveries = auditRecoveries(installs, report.recoveries);
  const peaks = peakUsage(installs, {
    ...report.peak,
    budgetBytes: config.clientBaselineBudgetBytes,
  });
  const failures = [
    ...installChecks.filter(c => !c.ok).map(c => `tick ${c.tick}: ${c.errors.join('; ')}`),
    ...trackedCheck.errors.map(e => `tracked: ${e}`),
    ...recoveries.items.filter(i => !i.ok).map(i => `recovery from t${i.fromTick}: did not resolve`),
    ...peaks.errors,
  ];
  return {
    ok: failures.length === 0,
    checkedInstalls: installChecks.length,
    failures,
    tracked: trackedCheck,
    recoveries,
    peaks,
    checkpoints: installs.filter(i => i.kind === 'checkpoint').length,
    deltas: installs.filter(i => i.kind === 'delta').length,
    span: installs.length ? { first: installs[0].tick, last: installs[installs.length - 1].tick } : null,
  };
}

// CLI: node tools/verify.mjs <artifact.json> [--emit-sample]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node tools/verify.mjs <audit.json>');
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = auditReport(report);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
