// Recovery decision. Inputs are only actual confirmed state and byte
// arithmetic: how old the common baseline is, what a delta from it costs, and
// what a full checkpoint costs.

export const STRATEGY = Object.freeze({ DELTA: 'delta', CHECKPOINT: 'checkpoint' });

export function chooseStrategy({
  installedTick,
  baselineAvailable,
  baselineTick,
  baselineAgeTicks,
  deltaBytes,
  checkpointBytes,
  maxBaselineAgeTicks,
  deltaToCheckpointRatio,
  retainedBaselines,
  baselineBudgetBytes,
  serverBaselineBytes,
}) {
  if (!Number.isFinite(installedTick) || installedTick <= 0) {
    return {
      kind: STRATEGY.CHECKPOINT,
      reason: 'no-confirmed-state',
      detail: 'client has not confirmed any installed state',
    };
  }
  if (!baselineAvailable) {
    return {
      kind: STRATEGY.CHECKPOINT,
      reason: 'no-common-baseline',
      detail: `no baseline at or below confirmed tick ${installedTick} is retained by both ends`,
    };
  }
  if (baselineAgeTicks > maxBaselineAgeTicks) {
    return {
      kind: STRATEGY.CHECKPOINT,
      reason: 'baseline-too-old',
      detail: `common baseline ${baselineTick} is ${baselineAgeTicks} ticks behind (limit ${maxBaselineAgeTicks})`,
    };
  }
  const ratio = deltaBytes / Math.max(1, checkpointBytes);
  if (ratio > deltaToCheckpointRatio) {
    return {
      kind: STRATEGY.CHECKPOINT,
      reason: 'delta-bigger-than-checkpoint',
      detail: `delta ${deltaBytes}B is ${(ratio * 100).toFixed(0)}% of checkpoint ${checkpointBytes}B (limit ${(deltaToCheckpointRatio * 100).toFixed(0)}%)`,
    };
  }
  return {
    kind: STRATEGY.DELTA,
    reason: 'common-baseline',
    detail: `delta ${deltaBytes}B from tick ${baselineTick} (age ${baselineAgeTicks}, ${retainedBaselines ?? 1} retained, server store ${serverBaselineBytes ?? '?'}/${baselineBudgetBytes}B)`,
  };
}
