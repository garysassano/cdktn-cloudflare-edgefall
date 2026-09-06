# W00 baseline and regression inventory

Implementation started 2026-09-06 from `8c3c41ee303d4fc1975fed60a0058ca4a74c735e` on `main`. W00 baseline characterization is complete. This establishes specific existing behavior, not acceptance of the redesign.

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

## Real browser lifecycle and footage

`pnpm test:e2e` runs Playwright against a real local Wrangler process and isolated `.wrangler/e2e` data, including local D1 migrations and an explicit test-only profile signing key. It does not use a deployed Cloudflare credential. Two browser contexts create distinct profiles, join the same room, ready up, receive authoritative combat state, move/jump/fire, and recover the same player/profile after reload. The first browser's recording includes the lobby and live encounter. Requested 10 ms key presses are measured as a baseline observation, not asserted to succeed in v2.

The recorded run saw zero jump commands from ten requested short taps. A held jump did produce a command and movement advanced the authoritative player more than 30 pixels. Reload established a second socket, retained the same player/profile, and advanced from tick 58 to tick 222 with two room members. There were no browser exceptions. [Recorded evidence and source hashes](./W00-artifacts/report.json), [13.8-second room recording](./W00-artifacts/room-lifecycle.webm), and [persisted-result recording](./W00-artifacts/persisted-result.webm) are checked in for durable review. Selected frames were visually inspected. These are software-rendered browser observations, not a claim about physical keyboard latency, audio quality, production networking, or game feel.

The separate result test inserts a declared fixture directly into local D1, then follows the real result API/page and leaderboard. It uncovered a real bug: fetching `/index.html` through Static Assets returns a canonical redirect to `/`, losing `/runs/:id`. The Worker now fetches `/` internally, preserving the user's result route. The real browser regression passes; this fixture does not prove the old terminal D1/R2 publication path.

Latest stable Playwright 1.63.0 was verified from the npm registry and added as a project development dependency. Its three packages have exact-version release-age exceptions beside the repository's existing Vitest exceptions, retaining the general three-day policy. The installed Chromium 151.0.7922.34 was selected using `EDGEFALL_CHROMIUM_PATH`; Playwright's default browser revision was not installed. Reproduce here with `EDGEFALL_CHROMIUM_PATH=/home/user/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell pnpm test:e2e`. Other machines should use their configured browser or normal Playwright-managed revision. No global tool configuration was changed.

Registry peer metadata was rechecked: `@cloudflare/vitest-pool-workers` 0.22.0 and `@cloudflare/vitest-plugin` 1.1.4 require Vitest 4.1, while this repository uses Vitest 5.0.0. Keep Vitest 5 and real Wrangler-backed tests; do not force incompatible peers. W02 owns deployed room cadence, cross-engine coverage and workload budgets. W06 owns human style acceptance. No deployment or paid workload has run.
