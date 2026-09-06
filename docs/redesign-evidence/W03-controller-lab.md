# W03 — Rendered controller laboratory

Status: the pure on-foot controller now drives an opt-in Phaser engineering surface. This is progress toward W03/G1, not final movement or gameplay acceptance. Production gameplay remains v2.

## Run and inspect

Run `pnpm dev:lab`, then open `/controller-lab.html`. The existing `/lab.html` retains the old v2 characterization fixtures. Both laboratories are emitted only by `scripts/build-client.mjs --lab`; an ordinary build cleans them out.

The course exposes ledges, gaps, a low obstacle, a one-way platform and vertical walls. The moving-support fixture begins with a grounded actor on a horizontally oscillating one-way platform. Removal is a recorded next-tick world command that increments geometry revision exactly once. The crush fixture lowers a solid ceiling onto a grounded actor and stops on the solver's explicit failure. Crossing the course kill bound also stops, retaining evidence rather than silently respawning.

The cyan collider, amber feet root/facing and magenta final contact normals are temporary diagnostic shapes. Green terrain identifies current support. Phaser draws results from the shared pure controller and owns no physics. The state panel exposes velocities, stance, support, buffer/coyote/drop timers, geometry revision, events and the complete movement result. Root-body fixtures shared by tests and this contributor tool live in `src/game/labs/foot-fixture.ts`.

Focus the surface for arrows/WASD and Space. Enter single-steps while paused; Space transitions are retained between ticks and browser auto-repeat cannot manufacture another jump edge. Down+Space drops through the selected one-way. Blur or page hiding pauses and clears held input. Run uses a 60 Hz accumulator with a six-step/100 ms frame cap: this is a responsive local diagnostic tool, not evidence of real-time cadence under stalls.

## Recording and verification

Each recording contains the scenario, at most 3,600 normalized tick commands including platform removal, and a canonical final-state fingerprint. Replay rebuilds the scenario and runs the same controller; a divergent fingerprint or commands after a stopped state are rejected. Export saves JSON. Import is bounded to 1 MiB and verifies the recording before replacing the displayed state. A rejected import preserves the current world. This is a local fixture recording, not the versioned multiplayer replay/archive contract, and it does not record unsampled physical event timestamps.

`pnpm test:lab:controller` starts a disposable loopback static server and installed Chromium, drives actual browser keyboard/focus/file events, captures a screenshot and recording, and closes both resources. It checks immediate movement, a jump pressed and released between ticks, crouch/stand, one-way drop, moving support carry, geometry removal, landing, blur pause/input neutralization, crush stop, export/import, tamper rejection and replay. The checked-in [browser report](./W03-controller-lab-browser.json) records bundle/screenshot hashes and complete selected states; the [screenshot](./W03-controller-lab.png) was visually inspected. Generated raw files remain under `dist/controller-lab-evidence/`.

`pnpm check` passes 203 tests across 20 files plus lint, asset/content validation, TypeScript, client/Worker dry-run builds and CDKTN synthesis. Three new pure-world tests cover support removal/replay, crush failure preservation and kill-bound/replay rejection. [Node/Chromium/local-workerd conformance](./W03-controller-lab-runtime.json) also passes after the fixture relocation, retaining controller trace `db17022f`; that report exercises the existing portable proof rather than claiming all new rendered scenarios ran in workerd. Report commit fields identify the pre-change base and hashes identify tested source/bundles.

## Remaining gates

This first rendered lab does not yet supply grounded enemy navigation, the complete spawn-overlap/maximum-motion/mirrored-geometry scenario matrix, failure-seed minimization, pose/timeline inspection, gamepad input, real input-to-visible latency percentiles, long gameplay replay or multiplayer prediction. Replay verifies and restores the final state; frame-by-frame playback of imported traces is still a contributor-tool improvement. W02 compiler/build identity, renderer stress, bandwidth, stable timing, recovery and live gates remain open. Grounded enemies/world integration and the remaining collision laboratory scenarios come next; W03/G1 stay open. No deployment, production bindings, dependencies or final media changed.
