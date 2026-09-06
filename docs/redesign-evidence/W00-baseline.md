# W00 baseline and regression inventory

Implementation started 2026-09-06 from `8c3c41ee303d4fc1975fed60a0058ca4a74c735e` on `main`. W00 is in progress; this is evidence for specific baseline behavior, not acceptance of the redesign.

## Reproduce

Run `pnpm check` for the existing suite and new deterministic reproductions. Run `pnpm dev:lab`, then open `http://localhost:8787/lab.html`. Choose `enemy-ledge`, `thin-obstacle`, or `jump-fire`; step, run/pause, reset, and toggle collision shapes. This is a scripted local simulation with no room connection. The normal build deletes the development lab from its output. Do not run a production build concurrently with the local lab server; restart `pnpm dev:lab` after a normal build replaces its assets.

For repeatable Chromium captures, start a disposable local Chromium with `--remote-debugging-port=9333`, then run `node scripts/capture-baseline.mjs`. The script verifies tick stepping, all three scenario outcomes, reset, and absence of browser exceptions. It writes state, browser version, source/worktree metadata and screenshot hashes to `dist/baseline-evidence/report.json`, alongside PNG captures. These generated artifacts are local and can be regenerated; they are not performance or human playtest evidence.

## Observations

The original baseline passed all 35 tests in seven files, lint, validation of 18 assets, all three TypeScript targets, browser/Worker builds and CDKTN synthesis. With the fixtures, 40 tests in eight files pass. Tools used: Node 24.20.0, project pnpm 12.0.0, TypeScript 7.0.2, Phaser 4.2.1, Wrangler 4.127.0. No packages were added or upgraded.

The `enemy-ledge` fixture places a rusher at x=150/y=200 on a ledge ending at x=160. After 30 ticks it is beyond x=200, still y=200 with zero vertical velocity. This directly reproduces missing ground-enemy gravity/support, without claiming that every authored encounter exhibits it.

The `thin-obstacle` fixture sends an 880-pixel/second bullet from x=100 through a four-pixel crate spanning x=111–115. At the next 30 Hz tick the bullet is at x=129.333, and the crate retains all 30 HP. The `jump-fire` fixture exercises simultaneous running, jumping and firing with a fixed input stream. All three fixtures compare complete state at each tick across duplicate Node runs; cross-runtime parity remains a later gate.

The collision overlay shows v2 platform/object rectangles, the controller's standing body dimensions, and enemy/projectile radii. It is diagnostic geometry, not a claim that v2 has separate accurate hurtboxes, shared support contacts, action IDs, or v3 prediction diagnostics.

The capture script passed all three scenarios and reset checks in HeadlessChrome 151.0.7922.34 on Linux using SwiftShader, with no browser exceptions. This is a local software-rendered smoke check, not hardware performance evidence or a human evaluation of movement/art. The thin-obstacle screenshot was visually inspected; the initial camera placed the reproduction outside the view, so the fixture player was moved closer and diagnostic shapes were added before the successful three-scenario capture.

## Existing product and persistence inventory

The current browser creates an anonymous profile, supports private invite rooms and daily runs, selects operator/outfit/weapon/ordnance, toggles ready, resumes reservations, pauses for upgrades, and displays shared results, history and leaderboards. Browser settings include volume, shake, flashes, contrast and reduced motion. Preserve profile identity/settings and useful room/result flows; the redesign deliberately retires active loadout customization, daily roguelite rewards and ability/reload/dodge controls.

The existing D1 migration defines `profiles`, `unlocks`, `runs` and `run_players`; runs include score, party size, daily flag, seed, result and summary JSON. That initial migration destructively drops prior prototype tables and must not be rerun as the redesign migration. Room storage uses `checkpoint-v2` and reservations; R2 replay exports use `edgefall-replay-v1` at 30 Hz. New campaign identity, ruleset-partitioned results, bounded replay storage and v3 room namespaces require explicit later migrations.

## Outstanding W00 evidence

Record real browser lobby/profile/result/reconnect behavior and existing encounter gameplay, including short-tap input behavior. Produce normal-speed footage with build metadata, rather than treating screenshots as recordings. Verify current package compatibility before selecting new dependencies. W01 contract work follows this baseline; W02 remote room cadence and W06 human style acceptance remain separate gates. No Cloudflare deployment or paid workload has run.
