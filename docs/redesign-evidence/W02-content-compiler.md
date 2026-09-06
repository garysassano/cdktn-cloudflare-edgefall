# W02 — LDtk compiler proof

Status: a bounded static encounter can now be compiled from raw LDtk into checked runtime content and exercised in the controller laboratory. This completes the first raw-input-to-runtime compiler proof, not the full authoring pipeline, renderer stress gate or W02 acceptance.

## Input and compiler boundary

The compiler vendors the official [LDtk 1.5.3 schema](https://raw.githubusercontent.com/deepnight/ldtk/v1.5.3/docs/JSON_SCHEMA.json) and MIT license. [LDtk's JSON documentation](https://ldtk.io/json/) identifies that schema version. Ajv 8.20.0 is a development dependency, pinned after checking the registry. Validation occurs before custom compilation and does not coerce or strip fields. `scripts/content/ldtk-1.5.3/README.md` records the schema digest and meta-schema alias.

The [authoring profile](../../content/engineering/README.md) defines the exact supported layers, fields, IDs, bounds and unsupported features. The synthetic fixture has full schema data, layer/entity definitions, collision cells and rendered tile references. It has not passed a graphical editor round-trip. No production mission or final asset is claimed.

The compiler merges coplanar solid runs deterministically, retains separate one-way planes, validates visible collision coverage and assigns terrain handles from anchor cells. Explicit entity handles do not depend on array order. Grounded starts require support and clearance. Every authored jump/drop is compiled through the shared foot controller. The checkpoint route must both exist and execute through the actual follower without leaving kill bounds. Missing camera regions, obstructed exits, bad references, floating spawns and impossible trajectories fail the build.

## Output and runtime proof

`pnpm content:compile` writes `src/game/content/compiled/navigation.json`. `pnpm content:validate` recompiles in check mode, rejecting stale output, and is part of `pnpm check`. Gameplay, graphics and combined build hashes are separate; graphics identity includes the PNG bytes. Input declaration ordering and editor-only metadata do not alter output. The compiler source is not loaded in gameplay; the runtime proof asserts that neither Ajv nor raw LDtk enters its browser bundle.

The `compiled-route` lab loads the generated three terrain rectangles, two jump links and checkpoint route. The scene renders the engineering tiles and collision overlay. The [inspected screenshot](./W02-compiled-route.png) shows the second jump at tick 60. [Browser evidence](./W02-compiler-browser.json) verifies arrival at (380, 300), support 1529, after 117 ticks and exact recording replay. This remains a local engineering fixture, not human gameplay-feel or renderer load acceptance.

[Runtime evidence](./W02-compiler-runtime.json) agrees across Node, Chromium and local workerd on the 117-tick trace `0f5d4d9f`, content hash `a6434f8f6468122005419e4c88336a3e6dbf29547ca01ed1057b818514c2dbb6` and build hash `e7042cbe2114695b232b5958580c5e3bd881da7f5adbe528f7e38ff3f7ae9688`. Earlier controller and route traces remain unchanged. [Compiler evidence](./W02-compiler-build.json) records the input, schema, artifact and compiler source hashes. Report commit fields identify the pre-change base; source and bundle hashes identify tested inputs.

`pnpm check` passes 270 tests across 26 files, including 22 compiler cases. These cover the concrete terrain output, successful route, declaration reordering, input purity, graphics-only changes, official-schema failures, unsupported authoring, hidden collision, duplicate handles, floating spawns, missing camera, obstructed exits, missing routes, invalid landing envelopes, path containment, kill-bound trajectory rejection, stable terrain handles, one-way planes and unknown timelines. Existing asset/content checks, all TypeScript targets, client and Worker dry-run builds and synthesis also pass.

## Remaining work

The compiler still needs editor round-trip evidence, production library/media selection, complete audio and client build negotiation, multi-encounter campaign packaging, hazard/flight/vehicle/moving-platform content, full checkpoint/vehicle route validation and world lifecycle integration. Unsupported roles currently fail rather than receiving placeholder behavior. W02 renderer stress, compact snapshots, stable cadence, actual browser impairment, recovery, staging cost and live gates remain open. W03/G1, W04 network integration and W06 human style acceptance also remain open. Production gameplay remains v2 and no live resources or bindings changed.
