// Headless audit producer: runs the deterministic link, records installed
// frames and lifecycle, then runs the same audit the browser export uses.

import { AuthoritativeLink } from '../shared/link.js';
import { auditReport, replayAuthority } from './verify.mjs';
import { toHex } from '../shared/wire.js';

export function buildAudit({
  steps = 600,
  impairment = { latencyMs: 60, jitterMs: 40, reorder: true, dropMiddleEveryFrames: 4, ackDelayMs: 600 },
  trackedId = 1001, seed = 7, config = {},
} = {}) {
  const link = new AuthoritativeLink({ impairment, seed, config });
  const installs = [];
  const lifecycle = new Map();
  const seen = new Set();
  const origInstall = link.client.onInstall;
  link.client.onInstall = (e) => {
    installs.push({
      tick: e.tick, seq: e.seq, kind: e.kind === 'checkpoint' ? 'checkpoint' : 'delta',
      bytes: e.bytes, baseTick: e.baseTick, digest: toHex(e.digest),
    });
    const prev = new Set(seen);
    seen.clear();
    for (const [id, s] of e.states) {
      seen.add(id);
      if (!prev.has(id)) {
        if (!lifecycle.has(id)) lifecycle.set(id, []);
        lifecycle.get(id).push({ tick: e.tick, event: 'appeared', detail: `${KIND(e)} seq ${e.seq}` });
      }
    }
    for (const id of prev) {
      if (!seen.has(id)) {
        if (!lifecycle.has(id)) lifecycle.set(id, []);
        lifecycle.get(id).push({ tick: e.tick, event: 'vanished', detail: `seq ${e.seq}` });
      }
    }
    origInstall(e);
  };
  link.run(steps);
  const snapshots = replayAuthority(link.config, Math.max(link.client.tick, 1));
  const trackedState = snapshots.get(link.client.tick)?.get(trackedId);
  const report = {
    kind: 'object-lab-audit',
    createdAt: new Date().toISOString(),
    source: 'headless',
    seed: link.config.seed,
    config: pickConfig(link.config),
    quant: { positionStep: 0.125, positionMin: -2048, positionMax: 2047, rotLevels: 65536 },
    installs,
    peak: {
      clientBaselineBytes: link.client.baselines.peakBytes,
      frameBufferBytes: link.client.collector.maxBufferedBytes,
      serverBaselineBytes: link.authority.baselines.peakBytes,
    },
    recoveries: link.client.recoveryLog.map(r => ({
      fromTick: r.fromTick, resolvedTick: r.resolvedTick, ticks: r.ticks,
      ms: r.ms, strategy: r.strategy, installedKind: r.installedKind,
    })),
    tracked: {
      id: trackedId,
      lifecycle: lifecycle.get(trackedId) || [],
      path: [],
      presentAtEnd: !!trackedState,
    },
    stats: link.sample(),
  };
  report.audit = auditReport(report);
  return report;
}

function KIND(e) { return e.kind === 'checkpoint' ? 'checkpoint' : 'delta'; }

function pickConfig(c) {
  return {
    seed: c.seed, stationary: c.stationary, moving: c.moving, pulser: c.pulser,
    transientCap: c.transientCap, baselineBudgetBytes: c.baselineBudgetBytes,
    clientBaselineBudgetBytes: c.clientBaselineBudgetBytes,
    maxBaselineAgeTicks: c.maxBaselineAgeTicks, deltaToCheckpointRatio: c.deltaToCheckpointRatio,
  };
}

if (process.argv[1] && process.argv[1].endsWith('audit-run.mjs')) {
  const steps = Number(process.argv[2] || 600);
  const report = buildAudit({ steps });
  console.log(JSON.stringify({
    ok: report.audit.ok,
    checkedInstalls: report.audit.checkedInstalls,
    failures: report.audit.failures,
    deltas: report.audit.deltas,
    checkpoints: report.audit.checkpoints,
    span: report.audit.span,
    recoveries: report.audit.recoveries.items,
    peaks: report.audit.peaks,
    tracked: report.audit.tracked,
  }, null, 2));
  process.exit(report.audit.ok ? 0 : 1);
}
