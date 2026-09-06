# W04: diagnosed input delay and authoritative replay mapping

The local controller laboratory now pairs every snapshot with an explicit server-issued command mapping. Production remains v2. This is bounded static-terrain controller evidence, not complete W04/G2 or W10 acceptance.

## Diagnosed failure

The earlier reconnect failure is preserved in [the room trace](./W04-mapping-trace-failure.json) and [the client traces](./W04-mapping-trace-clients.json). In run epoch 2, slot 0 captured command 22 at browser time 1120.5 ms and sent commands 22–24 at 1183.8 ms: 63.3 ms of capture-to-send delay. The server repeated held input at tick 55, admitted that packet after tick 55, then applied command 22 at tick 56 and command 23 at tick 57. Snapshot 57 therefore acknowledged 23 while the old client mapped pending command 24 into that already-authoritative tick. Its overlap guard correctly stopped prediction.

These are same-clock browser durations and explicit server ordering. Subtracting browser and workerd timestamps would not establish one-way network latency. This failure had no room clock fault; earlier host-correlated clock regressions remain separate evidence.

## Implemented contract

Protocol v3 capability 1 adds a JSON mapping immediately before its binary snapshot. The mapping binds run, connection, player, snapshot ID and tick, the first unprocessed sequence, and its earliest application tick. Strict pairing rejects missing, duplicate, mismatched and unnegotiated mappings. Pending commands replay sequentially after the restored full controller. Offset regression or active pending drift beyond six ticks requires a fresh baseline. An input-stopped observer can keep receiving snapshots but cannot later resume under excessive drift.

The legacy predictor retains its overlap rejection. Binary schemas, five-tick preload, six-tick admission limit, one-command-per-server-tick policy, 250 ms debt guard, four-tick catch-up limit, action identities and lease rules are unchanged. This does not silently retime server simulation or manufacture extra movement steps.

## Validation

- `CHECKPOINT_DISABLE=1 pnpm check`: 315 tests in 31 files, lint, licensed assets, compiled content, TypeScript and infrastructure synthesis pass. The environment variable bypasses optional CDKTN CLI telemetry only.
- Node, Chromium and local workerd agree on the forced delayed-command proof, trace `32c1bfa5`: tick 2 repeats held input, delayed jump command 2 applies at tick 3, and pending command 3 replays at tick 4 with the jump edge cursor still 1. [Portable proof](./W04-mapped-contracts.json).
- Four real browser contexts match 60 shared snapshots through tick 180 with no full-controller correction. Simultaneous short action taps advance all five action cursors once. The stopped peer remains neutral from tick 201 and expires at tick 366 despite 60 acknowledgment-only frames; other peers reach room tick 426. [Report](./W04-mapped-controller.json), [host/browser diagnostics](./W04-mapped-controller-diagnostics.json), [inspected engineering screenshot](./W04-mapped-controller.png).
- A separate same-context reconnect run replaces the session at a preserved nonzero tick and reaches tick 63 in all four clients without correction or room clock fault. Fresh-input barriers and key-repeat neutralization pass. [Report](./W04-mapped-recovery.json), [diagnostics](./W04-mapped-recovery-diagnostics.json), [screenshot](./W04-mapped-recovery.png). This run preceded the metrics-only addition of `inputMappingBytes`; the longer controller run includes that metric.

Reports identify the pre-change base commit and built bundle hashes; they were generated from the working changes delivered with this evidence. Diagnostic timelines are bounded to 1,800 client and 6,400 room entries, and routine client polling excludes the timeline. These traces add diagnostic work and do not prove production CPU cost.

## Bandwidth and remaining work

The four-player binary frame remains 1,416 bytes, plus a mapping payload averaging about 146 bytes in the longer run. Healthy peer 1 received 203,904 binary snapshot bytes and 21,026 mapping bytes across 144 snapshots. These are payload counts excluding WebSocket/TLS overhead. The busy-world bandwidth gate is still open.

Wrangler already enables invocation logs, trace sampling at 1 and source-map uploads. The trace configuration matches [Cloudflare's documented enablement](https://developers.cloudflare.com/workers/observability/traces/). No deployment or live trace ingestion was verified here. Production controller integration, automatic/per-player recovery, durable replay, moving geometry/vehicles/combat prediction, the degraded-network matrix, sustained timing and live workload cost remain open. No Rust rewrite or final asset work was introduced.
