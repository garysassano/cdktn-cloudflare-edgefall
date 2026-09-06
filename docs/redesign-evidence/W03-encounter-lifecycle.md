# W03/W05 — Explicit encounter lifecycle

Status: the deterministic encounter ledger now drives completion in the enemy laboratories. Full combat, campaign orchestration, network snapshots and W03/W05 acceptance remain open.

## Roster, event and completion contract

`EncounterLifecycle` owns one bounded authored roster: at most 256 members, 64 required objectives and four participants. Members declare whether they are required, critical, permitted to retreat, and eligible for optional ambient cleanup. A critical actor must be required and cannot retreat. Policy arrays are sorted and copied; restored state must match the same canonical policy identity.

A required member is an obligation while pending as well as alive, so a delayed spawn cannot open a gate early. Completion requires every required member to resolve and every objective to complete. Ambient survivors, pending optional spawns and resolved bodies do not block it. Counts derive from the explicit ledger, not the physical enemy array length. The `complete` notice is emitted once; adapters must check phase rather than treating a zero alive count as victory.

Authoritative events have a contiguous encounter-local sequence and an effective simulation tick. Input arrays are sorted by sequence. Canonical receipts make exact duplicates idempotent after plain-state restoration; gaps, conflicting duplicate payloads and new terminal events for an already resolved actor fail explicitly. Each bounded encounter retains at most 1,024 receipts. This is a local continuation contract, not a finished compact network representation. The combat owner must select one canonical terminal outcome for simultaneous damage/boundary contacts before emitting it.

Only a `killed` resolution may name a credited participant. Crush, out-of-bounds removal and permitted retreat resolve ordinary required members without kill credit. Forbidden retreat fails the encounter. A critical actor lost to a boundary, crush or retreat produces a failure notice; strict test mode throws. Separate solver-fault events fail progression while preserving the last accepted physical actor and unresolved member. They do not turn initial overlap, residual overlap, contact exhaustion or unresolved contact into a kill.

Retiring a checkpoint explicitly retires unresolved members and stops their obligations. It does not fabricate objective completion, a victory notice or kill credit. New events after retirement/failure are rejected, while exact historical duplicate receipts remain harmless.

## Diagnostics and world ownership

Every living member requires a tick observation containing a bounded progress key and explicit unreachable flag. The progress key excludes clocks/retry counters; the lab uses physical root and velocity. Unchanged and unreachable episodes maintain separate simulation-tick timers and emit one diagnostic bookmark per episode at the authored threshold. Restored timers and emitted flags prevent duplicate notices. Required or critical actors are never silently cleaned up by a watchdog.

Only explicitly eligible optional ambient actors may emit `remove-ambient` after their authored timeout. That notice must be consumed by the world to remove the physical actor at the same tick. Failure notices must stop campaign progression and be attached to the room's telemetry/replay context. Checkpoint retirement requires the world to unload the retired population. These production adapters and persistent telemetry are still pending; the pure ledger does not access storage, wall clocks or services.

## Physical laboratory evidence

The existing patrol and routed-enemy labs now feed actual activation/removal/fault outcomes into the ledger. `encounter-clear` provides a player platform and a separate enemy platform. Removing the latter at tick 11 makes the enemy fall through normal physics. At [tick 30](./W03-encounter-fall.png), the orange enemy is airborne and the encounter is still active. Crossing the authored root kill bound completes the encounter once at tick 49 with no kill credit. The cyan player remains safely supported.

Local recordings are format 6 because they now include encounter continuation and notices; earlier lab formats are rejected. The full 120-tick removal fixture is restored from plain state every tick and replayed from commands. A separate physical initial-overlap test verifies that the lab stops, keeps the prior enemy body, records the solver fault, and preserves its unresolved obligation.

`pnpm check` passes 283 tests across 27 files, including 11 direct lifecycle cases and two additional physical lab cases. Tests cover delayed required spawns/objectives, ambient survivors, declaration/event reordering, restored duplicate receipts, sequence conflicts, repeat terminal events, attribution restrictions, permitted/forbidden retreat, critical failures including same-tick batches, strict failure mode, watchdog episode reset, ambient-only cleanup, retirement and malformed continuation guards. Existing lint, asset/content validation, TypeScript, client/Worker dry-run builds and synthesis also pass.

[Node/Chromium/local-workerd evidence](./W03-encounter-runtime.json) agrees on removal trace `c0cc01b8`, the single completion notice at tick 49, and critical failure behavior. [Browser evidence](./W03-encounter-browser.json) verifies support loss, airborne movement, delayed completion, zero credit and exact replay. The controller (`db17022f`), route (`7ef3496e`) and compiled route (`0f5d4d9f`) physical traces remain unchanged. Aggregate routed-lab traces are now `647a1d23` and `15408864` because their fingerprints include the new ledger; the prior locomotion assertions still pass. Report commit fields identify the pre-change base; source and bundle hashes identify tested code.

## Remaining delivery

The production game remains v2. The ledger is not yet connected to compiled mission policies, damage/action timelines, boss phases, seat/vehicle lifecycle, campaign gates, durable journals or full snapshot/prediction codecs. Watchdog notices are local evidence, not deployed telemetry. W05 still requires actual four-player combat and the tank interaction lab. W02 renderer stress, bandwidth, stable timing, browser impairment, recovery and live cost/cadence gates remain open, as do W03/G1, W04, W06 human style review and the full W00–W13 campaign. No dependency, production binding, final asset or live deployment changed.
