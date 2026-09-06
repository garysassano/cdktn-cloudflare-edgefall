# W03 deterministic spatial indexing

Status: immutable static and per-tick moving collision grids are implemented in `src/game/physics/grid.ts` and connected to `moveKinematic`. The kernel can still run the exhaustive path as a reference. The active v2 game has not been switched; controller/root-shape integration, the rendered laboratory and W02 acceptance gates remain required.

## Geometry and solver contract

`CollisionGrid` copies and freezes all geometry. It validates IDs, terrain kinds, positive target dimensions, coordinate bounds and motion before any query, so malformed distant content cannot hide behind spatial filtering. Query results are unique and sorted by stable entity ID. Negative cells use floor division, and closed bounds retain contacts exactly on cell edges, including point queries. Moving entries cover their complete start-to-end swept rectangle, not just their final pose.

Reuse the static grid while its geometry is unchanged. Construct a `CollisionIndex` for each tick from that grid and current moving trajectories, identifying the exact tick and geometry revision. Moving geometry in the static grid, IDs shared by the static/dynamic grids, and stale/missing frame identity are rejected. Indexed `moveKinematic` calls require matching `options.frame`; the world owner still must supply the correct authored trajectory and geometry revision. Freezing the index prevents later source mutation from changing a supposedly identical collision frame.

The solver requeries the body's actual residual path after every collision. An obstacle that was irrelevant before a platform pushes the body can therefore participate in the next contact. Each moving target's conservatively rounded intermediate positions remain inside its original swept bounds, so the transient grid remains a valid superset throughout the tick. Support lookup, overlap correction and closing-trap proofs retain the full geometry set; filtering must not change those conservative decisions. Target cloning and these full-set operations still have costs and remain potential profiling targets.

Both 32- and 64-logical-pixel cells are supported, with 64 as the provisional default. There are at most 4,096 targets per frame, 256 cell references per ordinary entry and 65,536 total bucket references per grid. Large entries and entries exceeding that reference budget go into a bounded overflow scan instead of being dropped. A query spanning more than 4,096 cells scans the bounded entry set instead of walking millions of cells. Bounds stay inside ±2^24 subpixels; the full-world 32-pixel range has at most 4,097 cells per axis, and its cell-count product remains an exact integer. These fallbacks bound memory and iteration without changing results.

## Evidence

Eleven new tests cover negative/exact-boundary queries, duplicate bucket membership, moving-path crossings, immutable ownership, full-world and oversized-entry fallbacks, aggregate reference overflow, malformed geometry, stale identities and a moving-wall push into a previously unqueried obstacle. Exhaustive closed-bound filtering agrees with both cell sizes across 128 seeds and 16 queries per seed. Both indexed solvers match the full solver for 512 moving-obstacle cases with additional distant geometry, including complete poses and crush diagnostics. Indexed checkpoint restoration also preserves the existing 1,200-tick movement trace.

The [runtime report](./W03-grid-runtime-proof.json) records Node 24.20, Chromium 151 and local workerd agreement on a 512-fixed/32-moving/64-body engineering workload at both cell sizes. Both produce the reference hash `57a8413b`. Indexed 1,200-tick movement traces retain hash `8e99e568`, alongside the earlier snapshot, input, sweep, movement and restore checks. This does not establish complete controller/campaign replay, Firefox/WebKit support or deployed timing.

`pnpm bench:collision:grid` records a local Node comparison using that same engineering workload. Every timed batch's output is checked against the exhaustive result after timing. Each configuration has three warmup batches and nine samples; indexed timings include transient index construction and all 64 body queries. Reused static grid construction is measured separately as one cold observation. The [benchmark report](./W03-grid-benchmark.json) contains raw samples, machine/runtime identity and a source digest.

| Variant        | Median batch time |   Sample range | Cold static build |
| -------------- | ----------------: | -------------: | ----------------: |
| Exhaustive     |          27.67 ms | 24.98–34.82 ms |               n/a |
| 32-pixel cells |           5.94 ms |   5.68–6.30 ms |           1.42 ms |
| 64-pixel cells |           5.31 ms |   5.00–5.92 ms |           0.41 ms |

Initial narrow-phase candidate lists contain one or two of 544 targets in this deliberately spread-out scene. Static bucket references are 1,536 for 32-pixel cells and 1,024 for 64; transient references are 240 and 128 respectively. The 64-pixel default is supported by this preliminary observation, not proven optimal for the future authored encounters. This is a short, ordered Node microbenchmark with simple support/movement geometry, not a combat CPU profile, allocation/GC analysis, p99 guarantee or Cloudflare feasibility pass. Recheck cell size and remaining full-set costs on W03/W05 gameplay.

`pnpm check` passes 177 tests across 18 files, lint, asset/content validation, all TypeScript targets, client/Worker builds and CDKTN synthesis. Cross-runtime conformance passes on the final source. Report commit fields identify the pre-change base; source/bundle hashes identify the tested code. No new dependency, production binding, media asset or deployment is included in this milestone.

The root/shape adapters and pure on-foot controller are now documented in [W03-foot-controller.md](./W03-foot-controller.md). Next: grounded enemies and the rendered collision laboratory, world geometry/lifecycle journaling, complete prediction, failure-seed minimization and the compiler. Preserve the open W02 bandwidth/local timing/live gates and the profiling-first Rust/Wasm decision.
