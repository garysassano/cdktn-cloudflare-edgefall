# Laser integration

The laser is now registered in the deterministic combat laboratory and authoritative diagnostic room. Each accepted charge spends one of 120 starting energy and grants one damage pulse; sustained fire starts another charge every six ticks. The [laser kernel](W07-laser-kernel.md) owns the 512-pixel reach, four-pixel width, two damage, eight-entity penetration limit and energy material response. Later held ticks follow the accepted muzzle and recalculate clipping without another damage grant. A blocked muzzle spends the charge without emitting a beam. Empty energy falls back to the sidearm at the next accepted action boundary.

Release, owner death, action interruption and movement that blocks the muzzle end the attached geometry. Pause, waiting-connection replacement and run recovery settle affected charges without refunding energy or resetting cooldown. Campaign continue clears outgoing beams. The shared attack budget now includes beams, rockets and area attacks alongside projectiles, grenades and strikes. These are engineering graphics; no final laser art or audio was produced.

## Contracts and recovery

[Archive 14](../combat-checkpoint-v14.md), simulation/recording format 11 and [protocol 3.12](../events-v3.md) reject older experimental layouts. Private archives retain exact charge ownership, action, birth/current ticks and clipped muzzle geometry. Each living, unseated laser owner may have at most one charge at a committed boundary. Validation rejects extra fields, forged clocks or muzzle geometry, duplicate owners and invalid action/profile identities. The content digest includes the registered laser profile; the compiled Breakwater identity was regenerated.

Public snapshots use the existing 48-byte area-exposure record in combat snapshot section 3. An unobstructed beam occupies two contiguous 256-pixel segments. A shot event separately retains its exact birth muzzle, clipped length, width, heading and player/control-epoch/shot-ordinal confirmation. Event records grow from 64 to 76 bytes, with a maximum frame size of 4,896 bytes. Geometry is required only for registered beam shots; other events carry zero beam words.

Acknowledged birth geometry lets a short tap remain visible after its live snapshot volume has disappeared. The diagnostic client can show the received pulse for up to nine display ticks from first delivery when that owner has no active snapshot beam. Its event receiver suppresses duplicate delivery. This presentation never repeats damage or charges energy, and events beyond retention still require the existing explicit baseline repair.

## Validation

`pnpm check` passes 766 tests across 73 files, including thirteen laser integration cases and the earlier twenty-six kernel cases. Input onset/held deduplication, blocked-muzzle debit, moving cancellation, empty fallback, shield integrity/body sequencing, death, pause/recovery, archive corruption and delayed binary event delivery are covered. Asset validation, content validation, typechecks, the Worker dry-run bundle and CDK Terrain synthesis pass.

Node 24.20.0, Chromium 151.0.7922.34 and local workerd through Wrangler 4.128.0 agree on the accepted 72-tick four-player fixture. It accepts short taps and sustained upward/moving fire while handling 288 duplicate input packets. Every player fires at ticks `1, 7, 13, 19, 31, 37, 49`, finishes with 113 energy and three lives, and retains no live beam at the end. The encounter completes with two kills. Nineteen checkpoint/journal boundaries preserve exact future continuation and public binary snapshots. Final runtime hash is `6e14b3ed`; the full trace hash is `a40b2679`.

The actual SQLite harness restores twenty boundaries in fresh local workerd processes and keeps at most six archive rows. Every journal segment first injects a transaction failure and verifies that the saved prefix is unchanged before committing. Restored runtime hashes, paid weapon state, private beams, public exposures and event history match the portable fixture.

The Chromium inspector drives actual keyboard input and restores fourteen exported recordings at ticks `1, 2, 7, 8, 13, 19, 24, 25, 31, 37, 42, 43, 49, 50`, followed by a complete replay. Its single player accepts the same seven shot ticks and finishes at tick 72 with 113 energy. Selected screenshots retain the attached cyan engineering geometry.

The four-browser room verifier agrees on fourteen shared terminal snapshots through tick 132. The accepted stream contains 31 shots, 31 sound notices, eight impacts and two kills, with all clients matching the authority's full event hash `4a80b561`. Each player's sustained pulses remain six ticks apart. The final energy counts are `113, 112, 112, 112`: separate keyboard release times yield seven charges for the first player and eight for the others, and all clients agree on that state. Every captured input send stays within the validated snapshot's six-tick lead window.

The second reader drops four event frames and suppresses 72 duplicate events. Its first four beam events were born at authoritative tick 6, received while its cached snapshot was tick 15 and drawn at display snapshot tick 18. Those receipt/display fields describe client observation boundaries, not a measurement of the server's network-receipt time. Renderer instrumentation retains each cursor and the hash of the geometry actually drawn. Every decoded receipt's full cumulative hash, beam geometry and confirmation identity match authoritative history. The delayed-tap screenshot was taken after that stage; the draw records establish the brief afterimage itself.

The immutable [evidence package](laser-integration-2026-09-08/artifacts.json) retains 46 artifacts totaling 6,368,954 bytes, 374 repository source fingerprints and one bundled dependency fingerprint. All five rebuilt bundles match the tested contract, SQLite, room and browser outputs. It includes full reports, the project check, recordings and selected screenshots. Manifest SHA-256 is `cbcbdde401b9a454492600dfcf12311b7f0e7704af6ce34679ba888bef15398d`. Reports identify the preceding base commit; source and bundle fingerprints identify this tested increment.

Reproduce the checks with the installed toolchain and a Chromium executable:

```sh
pnpm check
pnpm test:contracts
pnpm test:storage:combat
node scripts/build-client.mjs --lab
node scripts/verify-combat-lab.mjs
EDGEFALL_CHROMIUM_PATH=/path/to/chrome pnpm test:network:controller --combat-laser
```

## Remaining work

This completes the laser engineering integration checkpoint. W07 still requires the remaining pickup/material/mission matrix and final weapon media. W08 vehicle work, the full campaign, production v3, deployed cadence and human acceptance remain open. The delivered W06 art/audio review remains pending without another review request. Traces, invocation logs and source maps remain enabled in the source and generated deployment configuration; [live ingestion](../observability.md) is unverified. Local workerd and browser correctness results do not establish deployed timing or per-tick CPU performance.
