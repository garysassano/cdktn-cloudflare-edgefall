# W03 — Grounded patrol and coplanar collision seams

Status: grounded enemy patrol now runs alongside the player in the rendered controller laboratory. Authored navigation links, combat, production world integration and W03/G1 final acceptance remain open.

## Grounded behavior

`src/game/actors/grounded.ts` owns a pure grounded patrol state with body, facing, geometry revision, turn count and explicit removal reason. It calls the shared root/body movement solver, not player-target Y assignment or engine physics. The module does not manufacture a player identity or consume player input cursors.

Before walking, the patrol validates its actual support and checks continuous coverage of its leading foot's entire intended path, including support carry. Coplanar adjacent spans can join, but any uncovered subpixel causes a turn; a fast step cannot skip a gap solely because its endpoint lands on another platform. Independently moving supports require authored trajectory/link work, so this automatic walking check only joins planes with equal motion. Existing wall contacts are checked against current geometry before causing a turn; removing a wall cannot preserve a stale turn request. Asymmetric turning uses the root-preserving clearance adapter.

A grounded patrol applies its own speed and gravity once; the solver adds support carry once. An airborne body retains its existing horizontal velocity and receives bounded gravity. Upward external impulses cannot reacquire the floor before leaving it. Removing support at the new geometry revision produces a real airborne transition, then landing on lower terrain. No target height participates in these decisions.

Crushing emits explicit `removed/crushed` state while retaining the last accepted body for diagnostics. Other collision failures expose no accepted enemy and require world recovery. Crossing authored root bounds emits `removed/out-of-bounds`; later ticks are inert. The lab records each enemy removal once without player kill credit. Full campaign required-entity/objective accounting and damage attribution remain separate work.

## Seam defect and fix

The adjacent-floor test exposed a shared solver defect: at the common corner of two coplanar floor tiles, gravity produced a floor normal and a redundant side normal. The side normal cancelled horizontal movement even though the real supporting face prevented entry below either tile. A body stopped at root X = -7 pixels instead of crossing the seam.

`moveKinematic` now discards an orthogonal corner constraint only when a witnessed, exactly touching face establishes the same plane and both targets have equal remaining motion along that face's normal. This applies symmetrically to floors, ceilings and walls. Standalone corner contacts retain both normals; unequal platform motion retains the collision. Geometry remains in all subsequent sweeps, and the diagnostic raw contact trace is preserved. No floating epsilon, positional push or terrain deletion is involved.

## Rendered and portable evidence

Run `pnpm dev:lab` and choose `enemy-ledge` at `/controller-lab.html`. The orange enemy patrols an elevated ledge independently of the cyan player. The removal button destroys its support at the next tick. [Inspected screenshot](./W03-grounded-enemy.png) shows the separate supported enemy and player. Local fixture recordings are now format 2 because their state includes enemy/removal records; old format 1 is explicitly rejected. This contributor recording is not the multiplayer archive format.

`pnpm check` passes 217 tests across 21 files, lint, asset/content validation, TypeScript, client/Worker dry-run builds and CDKTN synthesis. New coverage includes 64 platform widths × 480 patrol ticks with support/bounds assertions, continuous gap rejection, adjacent geometry order invariance, moving carry/removal, upward impulses, wall/stale-contact behavior, explicit crush/out-of-bounds removal, invalid spawn failure, player/enemy independence and restoration. Seam regressions cover all four rotations plus equal/unequal moving planes.

[Portable runtime evidence](./W03-grounded-runtime.json) records Node/Chromium/local-workerd agreement on a 1,200-tick enemy/player fixture with platform removal: trace `d37bb0a1`, unchanged after plain-state restoration at tick 600. The four rotated seam cases produce `20d540c1`. Existing player controller trace `db17022f`, indexed movement `8e99e568` and the 512 moving-obstacle cases retain their prior results. The enemy restoration is plain state, not proof of a new network snapshot section.

[Chromium report](./W03-grounded-browser.json) also verifies real player jump input while the enemy stays grounded, repeated ledge turns over 401 ticks, support removal, falling/landing and replay, alongside the previous lab checks. Report commit fields identify the pre-change base; source/bundle hashes identify tested code. No network, deployed cadence, frame-rate percentile or human gameplay-feel claim follows.

## Remaining work

Compile clearance-checked walkable spans and authored jump/drop links from level collision, validate their jump envelopes and geometry revisions, and implement traversal rather than implicit gap crossing. Add the remaining spawn-overlap/maximum-motion/mirrored rendered fixtures, failing-seed minimization and imported trace playback. Enemy snapshot/prediction, action/combat/encounter state, world geometry/lifecycle journals and production integration remain required. W02 compiler/build identity, renderer stress, bandwidth, stable timing, recovery and live gates remain open. No deployment, dependency, production binding or final media changed.
