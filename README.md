# Confirmed Object Lab

An online object sandbox with a real client and an independent authority. The
authority encodes world state as quantized positions, orientations, discrete
switches and create/destroy operations, splits each frame into tiles, and sends
it over a deliberately hostile link. The client assembles and verifies the
whole frame before atomically swapping its renderable world.

The interesting constraint is a **~3.2 KB baseline budget on each side**. Two
recovery paths exist and the authority picks between them from what the client
has actually confirmed:

1. **Keep an older common baseline and send a larger delta.** If both ends
   still retain a baseline the client confirmed, the authority diffs against it.
2. **Request a full checkpoint and restart from empty.** Used when no common
   baseline exists, when the common baseline is older than the age limit, or
   when the delta would cost more than a fraction of a checkpoint.

## Run it

```bash
npm start            # http://localhost:8080  (PORT / HOST env override)
npm test             # 40 unit + integration tests
npm run audit        # headless 900-tick audit, prints verification summary
npm run verify -- audit.json   # verify a downloaded browser audit
```

No dependencies: Node 20+ standard library only, browser code is plain ES
modules served from `/public` and `/shared`.

## What the window shows

- **Field**: the client's installed world. Click any object to track it.
- **Tracked object**: identity (id, label, kind), authority lifecycle (born /
  died), the client's exact quantized levels (`px`, `py`, `rot`, `on`, `kind`),
  the authority's digest for that tick, and a running cross-check. Everything
  here is read from the client's last *installed* world, never a partial frame.
- **Replication**: authority vs client tick, how far behind the confirmed tick
  is, frame counts, delta/checkpoint split, bytes delivered.
- **Baselines & budgets**: byte usage of the authority store, client store and
  reassembly buffer, plus the retained baseline ticks (pinned = the confirmed
  baseline, marked once the client confirms it).
- **Recovery log**: each episode with its cause, the tick range, wall-clock
  latency, and whether it resumed by delta or checkpoint.
- **Link control**: toggle in-order/out-of-order delivery, tile loss cadence,
  latency and jitter, and slow acknowledgements. Changes take effect on the
  next frame.

## Protocol

```
authority frame  = header(tick, seq, baseTick, kind, liveCount, recordCount,
                          baseDigest) || records*
record           = id || (FULL   : px py rot on kind label
                        | DELTA  : fieldMask + changed fields only
                        | DESTROY: nothing)
```

- **Quantization**: position is a signed 12-bit level at 0.125 world units
  (range −256..255.875), rotation a 16-bit turn. The client rejects values
  outside these bounds while decoding.
- **Tiles**: every frame is split into 96-byte payload tiles. Each tile header
  repeats the frame digest, and carries its own CRC. Tiles may arrive in any
  order and duplicate tiles are ignored. Loss cadence applies to small delta
  frames too: their two tiles lose one and must be retried.
- **Atomic install**: a frame is applied only if every tile arrived, every CRC
  passed, the assembled payload matches the frame digest, `recordCount` was
  consumed exactly, the baseline tick and baseline digest match a state the
  client *actually installed*, every record decoded, and the recomputed live
  count and world digest match the header. Otherwise nothing changes.
- **Acknowledgement**: after install the client sends `{seq, tick, digest,
  nonce, budget}`. `nonce` is derived from the frame the client just consumed,
  so an ack can only answer that frame. The authority rejects acks whose
  nonce or digest do not match a frame it actually sent.
- **Half-frame guard**: the client's baseline store is populated only by
  completed installs. A delta whose `baseTick` is newer than the installed tick
  is rejected as well, so a partially received or stale frame can never become
  the reference for the next round.

## Recovery strategy

`shared/policy.js` takes only confirmed facts and byte arithmetic:

| condition | decision |
|---|---|
| client has confirmed nothing | checkpoint |
| no baseline held by both ends at or below the confirmed tick | checkpoint |
| common baseline older than `maxBaselineAgeTicks` | checkpoint |
| delta bytes > `deltaToCheckpointRatio` × checkpoint bytes | checkpoint |
| otherwise | delta from the common baseline |

The authority's baseline store keeps the confirmed tick and the in-flight frame
tick pinned with priority over newer speculative snapshots. A rolling ring holds
recent ticks so a confirmed tick can be promoted back into the store without
being copied twice. When a confirmation is slow, the confirmed baseline is
retained across the gap — that is the "older common baseline, larger delta"
path. Measured deltas are ~180 B against ~3.5 KB checkpoints.

## Verification

The client's download button exports an audit: every installed frame (tick,
kind, bytes, base tick, world digest), recovery episodes, peak baseline and
buffer bytes, and the tracked object's client-side lifecycle.

`tools/verify.mjs` rebuilds the deterministic authority from the seed and
checks:

- every install digest against the authority's quantized state at that tick
- the tracked object's identity (kind and label), creation tick and survival
- that the client never saw the object before the authority created it
- that every reported path sample stays inside the quantization bounds
- that every recovery resolved to a later tick
- that peak baseline bytes stay within the declared budget

`npm test` also covers tamper detection (altered digest, fabricated lifecycle,
impossible peak) so the verifier is proven to reject bad input, not just
accept good input.

## Layout

```
shared/wire.js        quantization, records, digests, canonical world state
shared/packets.js     tiling, headers, CRC, reassembly
shared/frames.js      frame decoding, validation, atomic install, collector
shared/lab.js         deterministic sim, baseline store, snapshot ring, frame planning
shared/policy.js      the recovery decision
shared/session.js     authority and client
shared/link.js        virtual-time lossy link used headless and by tests
server/index.js       HTTP + WebSocket transport, impairment injection
public/               browser client and panels
tools/audit-run.mjs   headless audit producer
tools/verify.mjs      offline audit verifier
test/                 wire, packets, baselines, replication, audit
```
