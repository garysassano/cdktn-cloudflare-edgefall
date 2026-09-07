# Gameplay events v3.4

The combat room laboratory negotiates capability `3`: input mapping plus acknowledged gameplay events. The platform-neutral kernel emits notices; the room adapter maps those notices to the wire definition and stages them with the complete world/input transaction. Production gameplay remains v2. These are engineering combat payloads; final audio, predicted effects and complete combat recovery remain separate work.

## Binary frame

All fields are little endian. A type-3 event batch contains a 32-byte header and one to 64 fixed 64-byte records, at most 4,128 bytes. The run/connection identity belongs to the enclosing batch. Decoders validate its identity, exact size, content IDs, enum values, reserved fields, complete cursor sequence and event identity ordering before publishing any event.

| Header offset | Field                                           | Type    |
| ------------- | ----------------------------------------------- | ------- |
| 0             | Magic `0x4645`                                  | u16     |
| 2             | Major `3`, minor `4`                            | 2 × u8  |
| 4             | Type `3`, flags `0`                             | 2 × u8  |
| 6             | Exact total byte length                         | u16     |
| 8 / 12        | Run epoch / connection epoch                    | 2 × u32 |
| 16            | Last committed world tick covered by this batch | u32     |
| 20            | First record's delivery cursor                  | u32     |
| 24 / 26       | Record count / record byte size `64`            | 2 × u16 |
| 28            | Reserved zero                                   | u32     |

| Record offset     | Field                                                                                                                        | Type    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0 / 4 / 8         | Delivery cursor / tick / within-tick counter                                                                                 | 3 × u32 |
| 12                | Kind: shot `0`, sound `1`, muzzle-blocked `2`, impact `3`, killed `4`, melee `5`, throw `6`, action-sound `7`, explosion `8` | u32     |
| 16                | Origin: player `0`, enemy `1`                                                                                                | u32     |
| 20 / 24 / 28 / 32 | Owner / action instance / marker index / content definition                                                                  | 4 × u32 |
| 36 / 40           | Q256 x / y, each bounded to ±2²⁴                                                                                             | 2 × i32 |
| 44                | Target entity, zero for none                                                                                                 | u32     |
| 48                | Material: none `0`, terrain `1`, shield `2`, body `3`                                                                        | u32     |
| 52 / 56 / 60      | Confirmation player / control epoch / automatic-fire shot ordinal                                                            | 3 × u32 |

Counters never wrap and remain below `0xfffff000`. The event identity is `(runEpoch, tick, counter)`; the counter starts at zero each tick and is bounded to 511. The separate delivery cursor starts at one and increments for every event. All active clients receive the same ordered records. A frame can start partway through a tick when a previous frame or acknowledgment ended there. Events cannot describe a tick beyond the committed header boundary. The current adapter does not filter events.

Player firearm markers require a complete confirmation key with the same player as the event owner. Enemy markers carry origin `enemy` and zero confirmation fields; assigning them a player confirmation is rejected. Held-fire shots have their own monotonic shot ordinals, and every marker for one action keeps that key. Global action IDs remain authority-owned. The kernel captures marker payload, control epoch and shot ordinal when the marker fires; a later death in the same tick can cancel the action without erasing its shot confirmation. The explicit origin occupies one u32 in the 64-byte event record. Enemy release notices retain their authored timeline and marker identity privately for checkpoint validation. Knife activation, grenade release, action-sound and explosion records have no confirmation key, target or impact material. Their stable action identity remains the authority-owned action allocator; they do not consume firearm shot ordinals. Sound IDs are checked against the negotiated sound-marker table, and attack/impact IDs against attack definitions. Impact/kill records have zero confirmation fields; terrain impacts have no entity target, while shield/body impacts identify one. A kill record must describe a body impact. Unknown content references and partial confirmation keys fail closed.

## Retention and acknowledgment

`stageEventTick` produces an immutable candidate history for the next consecutive tick. The room installs that history and cursor only after the world/input transaction validates. Every tick contributes its events, including the two ticks between periodic snapshots. Retention is bounded to 120 ticks and 512 events. Age expiry and cap eviction have separate counters; a tick with more than 512 events or exhausted cursor space fails before commit.

At snapshot publication the server replays the retained suffix after that connection's acknowledged cursor, in bounded frames. `EventReceiver` validates an entire batch, deduplicates immutable previously consumed records and returns only fresh records for presentation. A missing cursor/identity prefix, changed duplicate or expired duplicate proof stops consumption and requires a baseline. The client retains at most 512 duplicate fingerprints. Presentation consumes the returned records before sending another acknowledgment; if that processing fails, the lab stops sending input/acks. Receipt does not mean an animation or sound has finished playing.

`InputBatch.eventAck` is the highest contiguous consumed/deduplicated cursor. `InputStream.recordSent` is called after the event suffix and accompanying snapshot were sent, so input admission rejects acknowledgments beyond that connection's sent prefix. Snapshot and event delivery do not renew the controlling input lease. Normal full snapshots carry the current `baselineEventCursor` as a state boundary; clients must not turn that field into an event acknowledgment without accepting an explicitly promised baseline.

## Explicit baseline repair

When an acknowledged cursor is older than the ring, the room sends this bounded control message followed by its paired input mapping and full binary snapshot:

```json
{
  "type": "resync-required",
  "scope": "events",
  "reason": "history-expired",
  "runEpoch": 1,
  "connectionEpoch": 1,
  "snapshotId": 50,
  "tick": 210,
  "baselineEventCursor": 380
}
```

The room then stops that peer's snapshots/event replay until the exact `snapshotId` and `baselineEventCursor` are acknowledged together. Earlier in-flight acknowledgments for previously sent data remain valid. A forged cursor jump paired with an older snapshot cannot accept the new baseline. The ordinary stalled-reader timeout still applies; the diagnostic connection allows at most eight event baseline offers. Other players continue normally.

The client fully decodes the promised snapshot, validates its tick/cursor/identity pairing, applies its authoritative state and input mapping, then installs the event boundary and explicitly acknowledges it. The omitted prefix is counted and never replayed as old gun sounds or kills. The supported snapshot restores current enemies, projectiles, weapon/controller state and explicit enemy removals. Snapshots include rifle/knife threat descriptors, grenade body/fuse projections, the encounter ledger and allocation state. Private timeline cursors, melee hit ledgers and grenade bounce state are restored through the [format 5 checkpoint and input journal](combat-checkpoint-v5.md). Authored mission progression and production v3 recovery remain unfinished.

If the client detects an application-level gap, it stops consuming events and sends a bounded request. This cursor is diagnostic context, not an acknowledgment:

```json
{
  "type": "event-resync-request",
  "runEpoch": 1,
  "connectionEpoch": 1,
  "lastEventCursor": 170
}
```

The room checks that the requested cursor belongs to data already sent to that connection, and offers the same full-baseline flow with reason `client-gap`. Unknown fields, wrong epochs and oversized controls are rejected. This event repair preserves the existing controlling session; it does not reconstruct a restarted room or reset uncertain physics/prediction history.

The four-browser verifier's `--events` mode separately exercises an intact dropped frame, duplicate delivery, a reader paused beyond retention, and an injected missing record after binary decoding to test the client's gap request. The last injection models a consumer fault; it is not a claim that TCP/WebSockets reorder individual records. Confirmed engineering hit/shot markers are deduplicated; no final audio or predicted-action promotion is claimed.
