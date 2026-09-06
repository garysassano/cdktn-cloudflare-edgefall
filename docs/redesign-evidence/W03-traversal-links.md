# W03 — Authored traversal links

Status: bounded static jump/drop links compile through the shared controller and execute in the rendered lab. Graph route selection, enemy traversal integration, raw content compilation and W03/G1 acceptance remain open.

## Compilation contract

`src/game/navigation/links.ts` defines an authored link by ID, kind, source span/root X, destination span/root interval, horizontal direction and a maximum duration of 1–180 ticks. `CompiledTraversal` requires a neutral, ready, supported standing actor at the exact source. It checks shape/revision compatibility and recompiles the supplied static surface to reject mismatched endpoint geometry. A drop additionally requires a one-way source and a lower destination.

The compiler runs the real `stepFootController` against collision geometry for every tick, using one launch edge and fixed authored horizontal intent. Drops include Down only on the launch tick. It rejects a failed/unconsumed launch, any wall/ceiling contact, an incorrect first landing, or a trajectory that never lands within the bound. Destination intervals must lie entirely inside a compiled full-foot/clearance span. These links prove one explicit trajectory from an exact source, not every point in a span or every possible velocity. Moving-platform trajectories remain unsupported and are rejected.

Definitions, commands and preview poses are immutable. The compiler retains locomotion continuation samples for verification. Runtime execution always simulates commands through the shared controller; preview coordinates are never assigned to the actor. Samples omit entity identity, combat state and diagnostic contacts, which remain world-owned. Compilation currently produces runtime instances from typed definitions; packaged raw-editor artifacts and content/build identity remain W02 work.

## Runtime and cancellation

A plain traversal cursor contains link ID, start tick and elapsed tick count. `begin` requires the compiled source continuation state. `step` requires the exact next collision frame and validates continuation before and after simulation. The launch edge appears once. On completion, the actor has physically landed and the cursor clears. Cursor plus actor can be restored into the same immutable compiled catalog; this is not yet a network snapshot section or a content-version recovery contract.

A geometry revision change or unexpected actor state cancels the route, clears queued jump buffering and runs neutral intent for that tick through actual current physics. Unexpected post-step motion cancels at the actual result. An airborne actor therefore continues gravity instead of freezing or snapping back to a sample. The world receives explicit cancellation and no active cursor; it must select recovery/manual/AI behavior on following ticks. Collision failure exposes no accepted actor. Lifecycle-inactive actors remain with their lifecycle owner.

## Rendered fixtures and replay

Run `pnpm dev:lab`, open `/controller-lab.html`, select `jump-link` or `drop-link`, queue the authored-link button and run or single-step. The purple line shows the validated feet path. While active, the route owns normalized movement intent; the fixture records launch requests and ignores repeated requests until it ends. Removing the destination invalidates the route at the next revision and hides the old preview. The lab continues ordinary controller physics after cancellation. Invalid launch positions report unavailable instead of teleporting to the source.

The jump fixture travels from (100, 300) across the gap to (253, 300) in 51 ticks. The drop fixture falls from (220, 220) onto (220, 300) in 27 ticks. These use the existing proposed engineering motion values, not measured reference-game tuning. The [jump](./W03-traversal-jump.png) and [drop](./W03-traversal-drop.png) screenshots were inspected. Local recordings are format 3 because launch commands and traversal cursor/status are now replay state; older local formats are explicitly rejected.

## Evidence and remaining gates

`pnpm check` passes 232 tests across 23 files, lint, asset/content validation, TypeScript, client/Worker dry-run builds and CDKTN synthesis. Nine added cases cover jump/drop compilation and execution, every-tick plain-state restoration, mirrored routes, invalid source/destination/duration/geometry, ceiling clearance, duplicate requests, cancellation with continuing gravity, unexpected runtime walls, failed spawns without accepted actors, wrong ticks and no snapping after state drift.

[Node/Chromium/local-workerd evidence](./W03-traversal-runtime.json) agrees on jump trace `4fc0de81`, drop trace `e52d9785` and combined route/cancellation trace `370d9102`. Existing controller, patrol, seams and navigation results also pass. [Chromium evidence](./W03-traversal-browser.json) verifies the real lab controls, exact landings, replay and destination removal during flight, alongside earlier lab checks. Report commit fields identify the pre-change base; source and bundle hashes identify tested code. Neither report proves deployed latency, full gameplay replay or human feel.

Next: graph route selection and grounded enemy traversal ownership using compatible shared locomotion state, raw authored-link/content packaging and content identity, then snapshot/prediction support for cursors. Moving-platform links, complete rendered collision cases, failure-seed minimization, imported trace playback and world lifecycle/geometry journals remain open. W02 bandwidth/timing/renderer/recovery/live and human gates remain unchanged. No deployment, dependency, production binding or final media changed; production gameplay remains v2.
