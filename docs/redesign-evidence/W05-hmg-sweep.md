# W05 authored infantry HMG sweep

The HMG now moves through authored intermediate barrel elevations while retaining the existing fire/action ownership. Both combat inspectors show the accepted hand-to-muzzle segment; matching integer velocities drive the actual swept bullets. Portable replay, SQLite recovery and the local keyboard inspector pass. Three initial automatic browser attempts reproduced input-lead and host-clock failures; the subsequent input-flow correction below supplies a passing four-browser HMG proof. The [acceptance audit](W05-acceptance-audit.md) still requires an integrated destructible-support combat fixture, and W06 must review final frames, sound and feel before remaining final media production.

Subsequent [input flow work](W04-input-flow.md) adds the missing client send limit without relaxing server admission. The portable regression preserves command 127 and its short taps until snapshot credit advances. The final four-keyboard run completes the sweep, mirror, jump/down-fire, crouch and idle-aim sequence through tick 160, with fifteen shared later snapshots and 294 agreed events. Each player fires 21 shots and retains 129 ammo and three lives. The initial evidence below remains tied to the HMG implementation; the input-flow evidence retains the later passing run and its preceding failures. Broader host-clock, impairment and final-media gates remain open.

## Direction and action rules

The desired direction remains ordinary movement/aim intent. The authoritative player separately retains barrel pitch and the next permitted turn tick. A change advances one heading immediately when eligible, then holds each heading for two ticks. Retargeting uses the current accepted pitch without resetting that exposure. Horizontal facing mirrors the sockets and velocity; it does not rotate the whole actor or restart the vertical sweep. Crouch lowers the barrel to horizontal immediately. Death and seating clear the independent gun state; empty-HMG fallback selects the sidearm's cardinal aim.

The table gives facing-right velocity in Q256 subpixels/tick and muzzle coordinates in logical pixels relative to the player's feet. These are authored engineering values for the benchmark, not timings or drawings extracted from the reference game. There is no runtime trigonometry or arbitrary pointer rotation.

| Pitch | Muzzle (x, y) | Velocity (x, y) | Timeline |
| ----- | ------------- | --------------- | -------- |
| -4    | (2, 0)        | (0, 4608)       | 16       |
| -3    | (6, -7)       | (1763, 4257)    | 200      |
| -2    | (11, -12)     | (3258, 3258)    | 201      |
| -1    | (14, -17)     | (4257, 1763)    | 202      |
| 0     | (15, -23)     | (4608, 0)       | 14       |
| 1     | (14, -29)     | (4257, -1763)   | 203      |
| 2     | (11, -34)     | (3258, -3258)   | 204      |
| 3     | (6, -37)      | (1763, -4257)   | 205      |
| 4     | (2, -38)      | (0, -4608)      | 15       |

Crouched horizontal fire uses its existing muzzle (15, -12) and timeline 17. Every sweep variant has the same four-tick action duration and marker schedule. Changing direction preserves action ID, start tick, consumed marker cursor and shot ordinal. The HMG still starts one shot every five ticks and debits one ammo per action, including a blocked muzzle. Hand-to-muzzle clearance and earliest terrain/shield/body collision use the actual authored exposure. A newly released bullet starts moving on the following tick.

## Recovery and protocol

[Archive 9](../combat-checkpoint-v9.md), protocol 3.8 and recording format 6 retain `firearmAim.pitch` and `firearmAim.nextStepTick`. Player records grow from 292 to 300 bytes; the maximum four-player allocation grows by thirty-two bytes to 51,272. Input/acknowledgment, event and vehicle record shapes are unchanged. The byte fixtures were independently updated with Python `struct`, inserting signed pitch and unsigned turn tick at player offset 192 and changing only the required header/version/length fields. Wire corruption tests cover the new signed bound and future exposure tick, and the maximum allocation remains tested explicitly.

The content digest includes the full sweep profile. Content checks reject missing headings, mismatched sockets and divergent marker schedules. Checkpoint validation also requires the active firing timeline to agree with the current heading and accepts only exact authored HMG velocities or their horizontal mirror. Movement prediction advances the same barrel state while preserving server ownership of global actions and damage.

## Verification

The required check passes 553 tests in 56 files, including ten new HMG cases, plus lint, original-asset/content validation, three TypeScript targets, client build, Worker dry run and CDKTN synthesis. The new cases exercise two-tick exposures in both directions, interrupted retargeting, action cursor/cadence preservation, immediate crouch, death, sidearm fallback, diagonal muzzle blockage in both facings, malformed content and forged checkpoint state.

Node, Chromium and local workerd agree on the admitted-input fixture: four HMG players run for 120 ticks with 480 duplicate packets and forty movement reconciliations. Each fires twenty shots and finishes with 130 ammo, ten grenades and three lives. It includes upward sweeps, return to horizontal, a real jump/downward sweep, reversal from down to up, mirrored fire, landing/crouch and idle aim after firing stops. Fourteen checkpoint/journal and binary snapshot boundaries cover ticks 1, 6, 7, 11, 26, 47, 48, 51, 66, 70, 96, 97, 101 and 102. The final state hash is `3789c55a`, trace hash `ba19a6da`; sampled snapshots range from 1,928 to 2,768 bytes. Runtime conformance is not a tick CPU or load measurement.

SQLite Durable Object storage cold-restores those fourteen boundaries and final tick 120 in fifteen fresh workerd processes. Every response matches the saved state exactly, including barrel pitch, next turn tick, cadence, marker cursor, shots, events and stock. Each journal segment injects a transaction failure and verifies the unchanged prefix before commit. The archive remains inside the six-row bound and finishes at the same state hash as the portable run. Existing tank, ordnance, area, shield, foot-combat, rifle, life, campaign and room-phase recovery regressions pass with the new player records.

The local keyboard inspector restores exact active recordings at ticks 6, 7, 11, 48, 51, 97 and 102, then finishes tick 120 with twenty shots and 130 ammo. Inspected rising and downward-fire screenshots show the authored hand/muzzle geometry at those accepted boundaries. This inspector advances explicitly accepted single ticks and does not establish automatic room cadence or multiplayer acceptance.

The first browser run completed the physical sweep sequence, but one client stopped after snapshot 120 when a packet ending in command 127 exceeded the server's six-tick lead. The room recorded `Client exceeds server-owned input lead` and continued for the other clients; there was no world, persistence or room-clock failure. Its 224 independent host samples contain no backward wall-clock step. This reproduces the existing W04 input-timing finding and does not establish the remaining snapshot/event acceptance criteria.

The second browser attempt entered clock recovery at accepted tick 26; 109 independent host samples contain backward wall-clock steps of 321 ms and 2,361 ms while the monotonic clock continued forward. The third attempt reached tick 114 before clock recovery, with backward wall-clock steps of 310 ms and 2,379 ms in 198 host samples. Neither has a world or persistence failure. All three initial attempts are retained with room state, client state and independent timing samples; none is a passing four-browser report. The input-lead, clock, event and persistence guards are unchanged. The subsequent input-flow evidence above supplies the complete automatic HMG run; broader timing findings remain open.

A separate full-suite attempt exceeded the existing five-second timeout in the older foot-combat replay test; the isolated test and subsequent unchanged full checks passed without increasing a timeout.

Initial verifier integration also found the old recording-format assertion and an omitted HMG path in the storage gateway allowlist. Both were corrected; their failed runs are retained.

The [artifact manifest](W05-hmg-artifacts.json) hashes the implementation, passed checks, recordings, inspected screenshots and failed browser evidence. The [source verification](W05-hmg-source-verification.json) independently rebuilds the portable and SQLite bundles and matches their report hashes; the final inspector bundle also matches. Failed browser reports did not record source/bundle hashes, so their provenance is limited to the recorded base commit, final source inventory and the documented sequence of local runs.

No deployed service, Worker binding shape, service flow or final runtime media changes here. The [configuration projection](W05-hmg-observability.json) rechecks explicit traces and invocation logs at 100% sampling plus source-map uploads in source and generated Wrangler configuration. Cloudflare requires the separate trace switch during the current beta; see the [official tracing documentation](https://developers.cloudflare.com/workers/observability/traces/). Live ingestion, host-clock/input-lead findings, production v3, long soaks, final media and human playtest gates remain open.
