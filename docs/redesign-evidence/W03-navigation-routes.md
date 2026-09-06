# W03 — Route selection and following

Status: the static navigation graph selects routes and a cursor-driven follower executes approach movement plus authored links in the lab. Grounded enemy decision/locomotion integration and production world/network ownership remain open; W03/G1 is not complete.

## Graph selection

`NavigationGraph` binds at most 256 links to one immutable compiled `WalkSurface` instance and one actor movement policy. Duplicate IDs, foreign surface/catalog instances, changed policies and stale geometry revisions are rejected. Links now expose their immutable actor definition and compiled surface for this ownership check. Packaged content/build identity is still W02 work.

The graph searches exact source and landing anchors using positive tick costs. It selects the lowest predicted cost among geometric candidates, breaking equal-cost ties by the numeric link-ID sequence, independently of insertion order. At most 257 nodes are settled and 65,792 link candidates examined; the pending map retains only the latest label per node. Plane/face interval lookups use binary search. The requested route budget is at most 3,600 ticks.

Walking approaches require a continuous full-foot/clearance span and a distance divisible by the controller's run speed. The planner does not round an unreachable source coordinate or invent analog speed. Since directional movement changes facing, a needed turn at an exact coordinate uses a legal one-step out-and-back where clearance permits it. A one-tick neutral settle stops motion before a launch or final arrival. Missing connections, incompatible stride alignment and unavailable facing clearance return unreachable.

Route selection is geometric, not proof of every possible actor continuation state. Timers, support identity, action state and immutable content ownership still have to satisfy the actual link launch gate. The follower cancels if they do not; the AI/world owner must decide how to wait, recover or replan. This avoids claiming that the geometric cost alone guarantees gameplay completion.

## Follower contract

`RouteFollower` validates leg durations, catalog links, continuous walking clearance, planned endpoint and total bound before execution. It keeps derived preview/assertion poses, never assigning them to the actor. Each actual tick runs the shared foot controller or the compiled link executor. The serializable cursor includes route start/elapsed ticks, leg index/elapsed ticks and the nested traversal cursor.

The exact next frame, cursor phase and expected root/facing are checked. The actor must satisfy a link's complete launch continuation at the transition. Wrong cursor/tick data is rejected. Changed geometry, unexpected state, unavailable launch or divergent physical movement cancels the route at its actual state. Cancellation still advances current physics once with neutral intent; failures expose no accepted actor. The world owns subsequent recovery and lifecycle behavior. Cursors have plain-state restoration proof, not a finished network snapshot or content-version recovery contract.

## Rendered proof

Run `pnpm dev:lab`, select `route-chain` at `/controller-lab.html`, queue the authored-route button, then run or step. The route crosses two gaps, walks back to the second source, changes facing through real inputs and arrives at root (380, 300) with zero horizontal velocity and support 102 in 117 ticks. The [inspected screenshot](./W03-route-chain.png) shows the second jump in progress. Removing the final platform cancels even during the first jump because the graph revision is stale.

Local fixture recordings are format 4 to include route cursor state; older local formats are rejected. Launch requests during an active route do not restart it. The initial cyan actor follows the route; this fixture does not claim that grounded enemy AI has been switched to graph-driven decisions.

## Validation and remaining gates

`pnpm check` passes 241 tests across 24 files, lint, asset/content validation, TypeScript, client/Worker dry-run builds and CDKTN synthesis. Nine added cases cover direct controller execution of the selected chain, every-tick cursor restoration, mid-flight cancellation, malformed plans/unavailable launch, lab recording/replay, deterministic ties, unreachable/alignment/budget/revision cases, facing clearance and catalog/policy mismatches.

[Node/Chromium/local-workerd evidence](./W03-route-runtime.json) agrees on the selected route, reverse link-order result, restored execution and cancellation, with 117-tick trace `7ef3496e`. Existing controller, patrol, seam, span and traversal proofs also pass. [Chromium evidence](./W03-route-browser.json) checks the actual route button, nested second-link cursor, exact goal, replay and removal cancellation, alongside earlier lab checks. Report commit fields identify the pre-change base; source and bundle hashes identify tested code. No live cadence, gameplay-feel, network or AI-load performance acceptance follows.

Next: give grounded enemies compatible shared locomotion state and graph/follower ownership, including decision/replanning and explicit encounter lifecycle outcomes. Raw content/link packaging, content identity, route/enemy snapshot/prediction, moving-platform links, remaining rendered collision cases, imported playback, failure-seed minimization and world journals remain required. W02 bandwidth/timing/renderer/recovery/live and human gates remain open. No deployment, dependency, production binding or final media changed; production gameplay remains v2.
