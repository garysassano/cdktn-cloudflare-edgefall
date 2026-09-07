# Combat checkpoint and applied-input journal v3

The diagnostic combat room uses archive format `3` and client protocol `3.2`. The archive preserves private world state, input acknowledgments, allocation/action cursors, encounter receipts, output event history, pause origin and campaign decisions. It supports the range, wall and shield fixtures. Authored mission progression and the production v3 room remain unfinished.

## Identity and reconstruction

Checkpoint and journal envelopes have exactly a format, protocol major/minor, kind, identity, canonical JSON payload and SHA-256 digest. Run ID, simulation version/build and content format/hash must match the caller's expected identity. Archives from formats 1 and 2 are rejected; the new diagnostic content digest includes `campaignFormat: 1`. No production v2 storage migration is implied. Payload and envelope bounds remain 512 KiB and 1 MiB respectively. The digest detects corruption and does not authenticate a run.

Capture clones the accepted world before asynchronous encoding. Validation checks the full client projection, player life phases, enemy continuation, encounter ledger, action/marker ages, projectile ownership, allocated IDs and contiguous event history. A paused room carries its original phase in `pausedFrom`; other room modes require `null`. Per-recipient delivery headers are excluded from the gameplay hash, while connection/control acknowledgment state remains included.

Applied-input journals retain one to fifteen contiguous ticks in one run epoch. Replay starts at the exact preceding tick/hash, reproduces the normalized input, external disconnect decisions and edge outcomes, and checks every resulting hash. Missing, repeated or changed segments fail without mutating the previous state. Replay does not re-admit packets or apply derived damage a second time. The bounded writer records accepted ticks synchronously, seals partial final segments and pauses when its thirty-tick backlog limit is reached.

## Wipe and continue

The world derives a wipe after every connected participant has exhausted their lives and finished the death presentation. Disconnected reservations do not block that decision. The campaign becomes `wipe` while credits remain and `defeat` after the final credit is exhausted. The room enters `intermission`, stops its simulation clock and watchdog, and immediately publishes the nonterminal input pause. This snapshot reports accepted state; host continue remains locked until the final journal write is confirmed. Packets sent before the client acknowledged this pause retain their original packet fingerprints and delivery checks, but their gameplay commands are discarded without consumption or lease renewal. Gameplay input after acknowledging the pause remains invalid. Defeat is not yet a published terminal result.

The signed host's `continue` command reconstructs the checkpoint at the current tick. It spends one shared credit, replaces enemies using fresh IDs from the existing allocation cursor, clears projectiles and checkpoint events, restores player entry anchors/lives/baseline equipment, and advances run, control and connection generations. Player identity, shot ordinals and the action allocator continue. Rebuilt encounter members activate from their pending roster on the next accepted tick, including after tick zero.

The checkpoint retains each external continue decision: ordinal, decision tick, checkpoint ID, source/result run epochs, pre-reset entity allocation cursor, retired/spawned enemy IDs and prior checkpoint kill credits. Validation checks contiguous credit accounting, ordered ticks/generations, the initial and subsequent retirement prefixes, unique monotonically allocated checkpoint IDs, kill ownership and the current required/resolved encounter roster. These decisions survive journal compaction.

Storage encodes the candidate before entering a synchronous SQLite transaction. Inside that transaction it repeats the host fence, checks the saved head prefix, replaces checkpoint/segment rows and advances the head together. Confirmation precedes installation and acknowledgment. A failed transaction preserves the old credit/IDs/players. A stale retry cannot spend again after a confirmed write, even if its response was lost. Cold recovery advances a connection generation without repeating the continue decision.

Installation closes old sockets and requires a new full baseline and input cohort in `loading`; only the current signed host can start it. New profiles cannot enter during a wipe, and ordinary `load` cannot bypass the continue budget. Reconciliation restores life state from authoritative snapshots without changing player ownership: ordinary death, protected entry and spectating do not require a socket replacement. Run, connection, control, body, vehicle and geometry fences still apply.

## Validation and remaining scope

Run `CHECKPOINT_DISABLE=1 pnpm check`, `pnpm test:contracts`, `pnpm test:storage:combat`, and `pnpm test:network:controller --combat-campaign`. The browser verifier uses four isolated Chromium contexts, real keyboard input, delayed final persistence and automatic reconnection. Set `EDGEFALL_CHROMIUM_PATH` to the installed browser. Local diagnostic fixtures and signing keys are excluded from the deployed Worker.

The existing lobby/loading/playing connection behavior is covered separately by `--combat-phases` and `--combat-auto-reconnect`. [Format 2 documentation](./combat-checkpoint-v2.md) and its linked evidence describe the earlier implementation. [Observability notes](./redesign-evidence/observability.md) retain unresolved timing observations and distinguish local instrumentation from live Cloudflare ingestion.

Authored mission exits and rally, terminal result/outbox publication, rematch, production membership recovery, v3 deployment, long impaired-network soaks and the human art/playtest gates remain open. Three retries of the diagnostic checkpoint do not constitute three authored missions.
