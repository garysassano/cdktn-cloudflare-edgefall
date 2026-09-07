# Combat checkpoint and applied-input journal v1

The combat laboratory now has a separate server reconstruction format. It preserves the private simulation continuation that the [3.1 client snapshot](./snapshot-v3.md) deliberately projects: all target bodies and patrol turns, encounter definition/receipts/watchdog timers, current tick notices, allocation/action/marker cursors, players, projectiles, acknowledgments, the retained output event history, and the connected input-owner roster. This format currently supports the existing sidearm/HMG range, wall and shield fixtures. It is not a production campaign checkpoint.

## Identity and bounds

Checkpoint and journal envelopes contain exactly `format: 1`, protocol major/minor `3/1`, kind (`checkpoint` or `journal`), identity, canonical JSON payload and its SHA-256 digest. The identity contains run ID, simulation version/build, content format/hash. Presentation identity is not part of authoritative replay. Every identity must match the caller's expected identity; changed versions, missing fields, noncanonical payloads, corruption and incompatible builds fail before reconstruction.

The diagnostic content hash is calculated from the actual content and firearm profiles. Its simulation build remains the explicitly synthetic probe identity; no deployed build provenance follows from this fixture. Payloads are limited to less than 512 KiB, and incoming envelopes to 1 MiB of UTF-8. The digest detects corruption and is not authentication or evidence that a simulation was fair.

Capture clones the live state before the first asynchronous digest operation. Checkpoint validation checks the complete snapshot codec and its projection against the private world, the encounter continuation, target life/support, projectile ownership/lifetime, action marker age, allocation cursors and contiguous retained event history. `EncounterLifecycle.restore` checks an existing continuation without advancing its tick or watchdogs.

## Accepted journal

`stageCombatRuntime` evaluates the existing combat kernel and output event staging under the same `InputStream.processWorldTick` transaction used by the conformance fixture. Each `CombatJournalTick` retains normalized `AppliedInput`, original submitted intent when present, edge outcomes, resulting acknowledgment cursors, ordered external decisions, the prior state hash and a resulting state-hash assertion. Missing commands retain their explicit held-repeat/stale decisions. A disconnected input owner is recorded as a connection change and neutralization; stale held input has a distinct neutralization decision.

The current laboratory supports these connection/neutralization boundaries only. Geometry, seat transfer, production membership and campaign transitions need their own implemented external-decision handlers; replay rejects unexplained additional boundaries. Journal replay does not feed old packets back through admission, consult a wall clock, emit client effects, or apply derived kill/damage events twice.

Segments contain one to fifteen consecutive ticks of one run epoch. Replay requires the exact previous tick and hash, reproduces outcomes and ordered decisions, and compares the entire generated journal entry before accepting its candidate. Missing, duplicate, reordered or changed segments fail without mutating the prior state. Per-recipient snapshot IDs and connection header selection are excluded from gameplay assertions; player connection/control acknowledgments remain included. FNV assertions are deterministic diagnostics, while the envelope SHA-256 covers the persisted payload.

## SQLite store and recovery boundary

`CombatStorage` is a laboratory adapter with one exclusive operation at a time. It commits fifteen-tick journal segments and replaces the checkpoint every sixty ticks. One SQLite transaction writes the segment/checkpoint, prunes superseded segments and advances a head record containing the committed epoch, tick and state hash. The store waits for `storage.sync()` before returning a confirmed durable boundary. Loading consumes a bounded database view before asynchronous decoding and requires every segment through that head. The table contains at most one checkpoint, three segments and one head row. The implementation uses synchronous transactions and parameterized SQL. [Cloudflare SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

The local storage verifier commits through tick 105 while its observed fixture reaches 119. A fresh workerd process reconstructs exactly tick 105, including both kill credits and the next entity/action IDs. The fourteen later ticks are intentionally absent. Injecting an exception between the data write and head update preserves the previous tick-45 and tick-90 states for checkpoint replacement and segment append respectively; deleting an intermediate committed segment rejects recovery. The verifier uses the installed Miniflare `resourcePersistencePath` option and owns/removes its temporary database directory.

The continuous WebSocket room does not yet use this store. Wiring a bounded asynchronous writer, pausing before the recovery backlog is exceeded, incrementing/persisting run and control epochs, clearing old input/delivery state, and requiring a fresh client barrier remain the next integration work. A cold store reconstruction alone does not demonstrate those room semantics, host crash guarantees, deployed storage latency or lossless recovery. The production Worker remains v2.

## Verification

Run `pnpm test:contracts` for Node/Chromium/local-workerd agreement, `pnpm test:storage:combat` for the owned SQLite restart and transaction-failure proof, and `pnpm test:network:controller --combat-baseline` for four-browser encounter repair after missed kill effects. The browser command needs the installed Chromium path through `EDGEFALL_CHROMIUM_PATH` in this workspace. Run `CHECKPOINT_DISABLE=1 pnpm check` for the repository gate; the flag only bypasses optional CDKTN CLI telemetry.
