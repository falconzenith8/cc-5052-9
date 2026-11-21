import { AuthoritativeLink } from '../shared/link.js';
import { toHex } from '../shared/wire.js';

const link = new AuthoritativeLink({
  impairment: { latencyMs: 60, jitterMs: 40, reorder: true, dropMiddleEveryFrames: 3, ackDelayMs: 200 },
  seed: 42,
});
link.run(200);
const s = link.sample();
console.log(JSON.stringify({
  authorityTick: s.authorityTick, clientTick: s.clientTick,
  framesSent: s.framesSent, framesSentByKind: s.framesSentByKind,
  framesInstalled: s.framesInstalled, rejects: s.framesRejected,
  deltas: s.deltas, checkpoints: s.checkpoints, framesLost: s.framesLost,
  match: s.match.ok, diffs: s.match.diffs.slice(0, 3),
  peak: s.peak,
  recoveries: s.recoveryLog.length,
  lastDecision: s.lastDecision,
}, null, 2));
