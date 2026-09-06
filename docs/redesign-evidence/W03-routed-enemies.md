# W03 — Enemy navigation ownership

Status: locomotion-only enemy state now owns graph decisions and route execution in the controller laboratory. Combat, campaign encounter accounting, production integration and W03/G1 acceptance remain open.

## Shared physics and ownership

`FootActor` contains reversible body, locomotion, action, facing, input timers, support and geometry state. `ControlledActor` extends it with player identity, inventory, combat and transport fields. The foot controller, authored link executor and route follower preserve the caller subtype, so enemies use the same physics without fabricated player identities or inventories. Player snapshot field layout and golden bytes are unchanged.

The controller clones its body, contacts and action records. Caller-owned extension objects are preserved by reference and never mutated by this core; inventory or transport owners must copy their own records when changing them. This is a locomotion ownership contract, not a general deep-clone API.

`RoutedEnemyDriver` plans from the actual grounded, settled actor and runs one controller/follower tick per world tick. Unreachable goals retry every 30 ticks. Goal or geometry changes cancel the old route and run neutral physics once; an airborne enemy waits for a real landing before replanning. Launch/state/trajectory cancellation also retains actual physics and delays another attempt. No target Y or preview pose is assigned to an enemy.

The serializable enemy state owns the goal, route, nested cursor, retry tick, plan count and status. Up to 32 cached followers are disposable; unit tests reconstruct the driver every tick and reconstruct the graph midway through a jump. Compiled geometry remains an external immutable catalog. This proves plain-state continuation, not a completed enemy network codec or build/content-version recovery contract.

Proven crush and root departure from authored bounds emit explicit removal events once. Failed initial overlap returns no accepted enemy. The lab records environmental removals without kill credit. Combat damage, death timelines, wave eligibility and full encounter completion accounting remain world-owned work.

## Rendered and runtime evidence

Select `enemy-route` in `pnpm dev:lab`. Cyan remains keyboard-controlled while orange automatically crosses two authored jumps and reaches (380, 300), support 102, in 117 ticks. The [inspected screenshot](./W03-routed-enemy.png) shows tick 60 during the second jump with the separate player on the first platform. Purple is the compiled route preview, not a physics override. These are engineering graphics, not final assets or human style acceptance.

Removing the final platform at tick 61 creates geometry revision 2 and recompiles the surviving catalog. The enemy cancels once, continues gravity, lands at (212, 300) on support 101, and reports the destination unreachable. The first link survives compilation; the link to the removed destination does not. Local recording format 5 includes enemy continuation and event state; earlier local recording formats are rejected.

`pnpm check` passes 248 tests in 25 files, lint, asset/content validation, TypeScript, client and Worker dry-run builds, and CDKTN synthesis. Added tests cover player/enemy physics parity, driver and catalog reconstruction, unreachable retry bounds, changed-goal recovery, missing-catalog gravity, one-time environmental removal, failure separation, independent player control and lab replay after geometry changes.

[Node, Chromium and local workerd](./W03-routed-enemy-runtime.json) agree on both 150-tick lab traces: `6eaa6f07` for arrival and `b454a5f7` for destination removal. The prior controller (`db17022f`), patrol (`d37bb0a1`), seam (`20d540c1`), spans (`40a032ce`), authored traversal (`370d9102`) and route (`7ef3496e`) hashes remain unchanged. [Browser checks](./W03-routed-enemy-browser.json) exercise keyboard input, autonomous enemy arrival, removal cancellation, exact gravity continuation, landing and recording replay. Report commit fields identify the pre-change base; source and bundle hashes identify the tested code.

## Remaining scope

Next work must supply raw content/link packaging and build identities, complete enemy/route snapshots and prediction, combat and encounter lifecycle integration, moving-platform navigation, remaining collision fixtures, failure-seed minimization and world journals. W02 renderer stress, bandwidth, stable timing, reconstruction and live cost/cadence gates remain open. W06 human style review and the full W00–W13 campaign remain required. The production game still uses v2; no deployment, dependency, binding, final media or architecture flow changed.
