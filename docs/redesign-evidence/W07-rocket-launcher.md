# Rocket launcher integration

The launcher is now available in the deterministic combat laboratory and authoritative diagnostic room. It uses the [released-rocket kernel](W07-rocket-kernel.md) through the same accepted firearm actions as the existing weapons: one round per action, 24-tick cadence, cardinal muzzle poses, a 20-round starting supply and sidearm fallback when empty. Short taps and onset-plus-held input cannot create a second charge. A blocked muzzle spends the round without spawning a missile or blast.

The shared world owns flight, lock retention, bounded steering, collision, explosions and kill credit. Rockets remain active after the firing owner dies, and a campaign continue clears outgoing flight. The inspector shows the flight body and direction separately from the blast radius. Its `rocket` scenario supports one to four slots and exact recording replay. Launcher launch audio stays silent until its reviewed family exists; engineering explosions use the existing blast cue. No final launcher media was produced.

## Contracts and recovery

[Archive 13](../combat-checkpoint-v13.md) and simulation/recording format 10 retain the private rocket array, including launch/current heading, speed, target identity and both guidance clocks. Older layouts are rejected. Checkpoint validation covers exact fields, ownership, one rocket per charge, allocation bounds, current tick, lifetime, motion, lock roster, clock phase and full body bounds. It permits a lock whose known target was killed later in the same tick; the next motion step drops it.

Protocol 3.11 already has the necessary 48-byte projectile record and acknowledged explosion event. The public record carries attack 17, flight shape 19, quantized heading, position/velocity, birth tick and lifetime. Blast shape 20 is distinct. The existing moving-platform shape IDs 17 and 18 remain intact. The content identity includes the registered launcher and guidance profile. The compiled Breakwater content digest was regenerated because it includes the shared combat catalog; mission weapon pickups and final launcher presentation remain separate work.

## Validation

`pnpm check` passes 727 tests across 71 files, including launcher input/pose/fallback, private recovery corruption, owner death and audio routing, plus the earlier twenty-one kernel cases and all existing checks.

Node 24.20.0, Chromium 151.0.7922.34 and local workerd through Wrangler 4.128.0 agree on the accepted 160-tick four-player fixture. It jumps, fires a short airborne tap at tick 7, and holds fire for releases at 31 and 55. All 640 duplicate packets are handled without extra charges. Each player finishes with seventeen rounds and three lives; the two enemies resolve with two total kills. Sixteen checkpoint/journal boundaries preserve the private flight state and exact future continuation. Final runtime hash is `ba5ca38c`; the full trace hash is `70bbdbaf`.

The actual SQLite harness restores seventeen boundaries in fresh workerd processes, including birth, steering, contact, damage and expiry, while retaining at most six archive rows. Every journal segment first injects a transaction failure and verifies that the saved prefix is unchanged before committing. Restored full-state hashes, public flight records, private locks/clocks and ammunition match the portable fixture.

The Chromium inspector uses actual keyboard events for the same three release ticks. Seven exported recordings restore exactly across birth, steering, contact and lifetime boundaries, followed by a complete replay. This single-player run detonates at ticks 35 and 69, ends with seventeen rounds and no rockets, and completes the encounter. Its selected screenshots show engineering geometry.

`pnpm test:network:controller --combat-rocket` drives four real keyboards against one authoritative local workerd room. Two short taps per player yield eight accepted shots, four explosions and two kills, with eighteen rounds left per player. All clients agree on sixteen terminal snapshots through tick 174 and 33 shared events. One reader receives 33 duplicate events and presents each event once. Every captured input send stays within the last validated snapshot's six-tick lead window. This is local room evidence; the host/deployed timing gates remain open.

The immutable [evidence package](rocket-launcher-2026-09-08/artifacts.json) retains 31 artifacts totaling 4,609,140 bytes, 365 repository source fingerprints and one bundled dependency fingerprint. It includes the complete reports, tested bundles, keyboard recordings, screenshots and project check. Its five rebuilt bundles match the conformance, SQLite, inspector and network outputs. The manifest SHA-256 is `9526d2544a8a77fc97e289b75f575100723f6e2bd36c0d5a697843d012993190`. The reports identify the preceding base commit; their source/bundle hashes and the package identify this tested increment.

## Remaining work

This closes the launcher engineering integration checkpoint, not W07 or the full redesign. The remaining weapon family, pickup/mission coverage, final launcher art/audio, production v3, the vehicle/campaign work and human acceptance remain open. The delivered W06 review package is unchanged and its human review remains pending. Worker traces, logs and source maps stay enabled locally; [live trace ingestion](../observability.md) is still unverified. These fixture durations are not per-tick CPU profiles.
