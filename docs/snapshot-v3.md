# Arcade full snapshots v3.10

The input/handshake contract is in [protocol-v3.md](./protocol-v3.md). This full snapshot format carries exact local controller state, remote entity state, hostile threat descriptors and explicit removals. It is not a checkpoint or replay encoding. Static geometry, textures and definition tables are identified by the negotiated content build and are not resent here. The active product remains v2 until W04 integration.

## Frame header

| Byte offset | Field                          | Encoding                 |
| ----------- | ------------------------------ | ------------------------ |
| 0           | Magic EF (`0x4645`)            | u16                      |
| 2           | Major 3, minor 10              | u8, u8                   |
| 4           | Message type 2, flags 0 or 1   | u8, u8                   |
| 6           | Exact frame length             | u16                      |
| 8           | Run epoch                      | u32, nonzero             |
| 12          | Controlling connection epoch   | u32, nonzero             |
| 16          | Snapshot ID                    | u32, nonzero             |
| 20          | Snapshot server tick           | u32                      |
| 24          | Baseline event delivery cursor | u32                      |
| 28          | Collision geometry revision    | u32, nonzero             |
| 32          | Diagnostic FNV-1a state hash   | u32, all 32 bits allowed |
| 36          | Player count                   | u8, 1–4                  |
| 37          | Vehicle count                  | u8, 0–16                 |
| 38          | Enemy count                    | u16, 0–128               |
| 40          | Projectile count               | u16, 0–256               |
| 42          | Dynamic platform count         | u16, 0–64                |
| 44          | Threat descriptor count        | u16, 0–128               |
| 46          | Removal ID count               | u16, 0–512               |
| 48          | Room mode                      | u8 enum                  |
| 49          | Reserved zero                  | 15 bytes                 |

Room mode is indexed from `lobby, loading, playing, intermission, paused-empty, recovering, completed, expired`. The minimum frame is 448 bytes and the base sections can reach 39,432 bytes; the maximum combat section raises the complete frame limit to 52,060 bytes. This hard allocation limit is not the 6 KiB steady-traffic target; W02/W04 must measure representative populated rooms and reduce traffic before accepting the performance gate. No compression or render quantization is implied by this format.

## Record sequence and sizes

The 64-byte header is followed by the records below, in this exact order. Entity record fields are four-byte little-endian words; the combat section declares its u16 fields separately. Unsigned words are u32, signed fields are i32, booleans are exactly 0 or 1, and nullable IDs use zero for null. Non-null IDs must be positive. Definition/shape table indices fit 1–65,535, except explicitly idle/unset action definitions and static trajectory IDs may be zero. Counters stay below `0xfffff000`; positions are bounded to ±2^24 subpixels and velocities to ±2^16 subpixels per tick. Timer/ammo/health counters are bounded to 65,535. Enum values are zero-based positions in the lists below.

| Section                   | Record bytes | Count            |
| ------------------------- | ------------ | ---------------- |
| Camera/campaign           | 40           | 1                |
| Processed acknowledgments | 40           | Player count     |
| Controlled players        | 304          | Player count     |
| Vehicles                  | 324          | Vehicle count    |
| Enemies                   | 64           | Enemy count      |
| Projectiles               | 48           | Projectile count |
| Dynamic platforms         | 32           | Platform count   |
| Hostile threats           | 64           | Threat count     |
| Removed IDs               | 4            | Removal count    |

Camera/campaign words: `camera.x` (signed), `camera.y` (signed), ruleset (`classic, accessible`), mission (1–255), checkpoint ID, continues remaining, continues used, phase (`playing, wipe, intermission, victory, defeat`), encounter ID, remaining encounter requirements (0–320). The shared gameplay viewport remains 384×216. With the combat flag set, the remaining count equals unresolved required members plus incomplete objectives (zero for a retired encounter). The combat section below carries public lifecycle and kill accounting; private AI/watchdog/receipt continuation remains in the server checkpoint.

Acknowledgments use the existing ten-word record in protocol-v3.md, in the same order as the player records. Player ID, control epoch and edge cursors must agree with the corresponding controller. The local acknowledgment must match the connection epoch, and its processed tick cannot be later than the snapshot tick. A snapshot can include repeated held-input ticks after the last processed command; prediction restores from the snapshot tick, not from the older acknowledgment tick.

## Reusable body, action and weapon records

A body is 140 bytes. Its first eleven words are `id, x, y, vx, vy, remainderX, remainderY, shapeId, supportId, grounded, contactCount`. Position, velocity and remainder words are signed. Remainders have absolute bound 131,071. The body then has exactly four 24-byte contact slots. Each used slot is `otherId, normalX, normalY, toiNumerator, toiDenominator, kind`; normals are signed and exactly one axis is ±1. Contact kind is `solid, one-way, platform`; the denominator is positive and ≤2^17 and the numerator is between zero and the denominator. Unused slots are all zero. A grounded body has a non-null support; removed supports/contacts are invalid.

An action is 20 bytes: `kind, actionInstanceId, stateStartTick, definitionId, nextMarkerIndex`. Kinds are `ready, fire, melee, grenade, enter, exit, hurt`. Active actions need nonzero instance/definition IDs and cannot start in the future; the next marker index is bounded to 128.

A weapon is 20 bytes: `id, ammo, cooldownTicks, shotOrdinal, lastActionInstanceId`. IDs are `sidearm, heavy-machine-gun, shotgun, rocket-launcher, flamethrower, laser`. Unlimited sidearm ammunition is represented by its immutable definition, not an infinite/NaN wire value.

## Players and vehicles

A 304-byte player record is: body; `playerId, slot, controlEpoch, life, lifeStartTick, deathBody, locomotion`; action; `facing, aim, firearmAim.pitch, firearmAim.nextStepTick, jumpBufferTicks, coyoteTicks, ignoredSupportId, ignoredSupportTicks, invulnerableTicks, reboardCooldownTicks, vehicleSpecialTicks, vehicleId`; weapon; `grenadeStock, grenadeCooldownTicks, meleeCooldownTicks, geometryRevision, health, lives, lastRallyMission`; then five processed edge cursors in input edge-kind order. Facing is signed ±1. Life is `alive, death, respawning, spectating`; locomotion is `grounded, airborne, crouched, seated`; aim is the input aim enum. `lifeStartTick` is an unsigned tick no later than the snapshot tick, independent of the action clock. Death, entry and spectating delays therefore survive baseline reconstruction and action cancellation. `deathBody` is a u32 enum: 0 for null, 1 for present, 2 for removed. Only the death phase permits present or removed; every other phase requires null. Removed bodies retain their bounded last position with zero velocity/remainders, no support/contacts, false grounding and airborne locomotion. A dead player cannot own a vehicle or active action. Presence changes never reset the life clock. `firearmAim.pitch` is a signed authored elevation index from -4 (down) through 0 (horizontal) to 4 (up), mirrored by facing; `firearmAim.nextStepTick` is the unsigned tick when the barrel may advance again, bounded to the snapshot tick plus the maximum sixty-tick content exposure. The combat archive also checks the actual weapon profile, lowered/crouched state and active pose. These fields are independent of requested aim, cadence, shot ownership and consumed action markers. Every field of `ControlledActor` is round-tripped without reduced precision.

A 324-byte vehicle record is: body; `definitionId, kind, lifecycle, occupantId, reservedBy, controlEpoch, armor`; action; weapon; component count; eight component slots of `id, health, broken`, with unused slots all zero; then `ownerControlEpoch` (nullable u32), `facing` (signed i32, -1 or 1), `heading` (u32, 0–7) and `invulnerableTicks` (u32, 0–65535). Kinds are `tank, walker, aircraft`; lifecycle is `available, boarding, occupied, exiting, destroying, wreck`. Component count is 0–8. Occupants are player body/entity IDs, not profile/player membership IDs. An occupant may remain attached during exit or destruction until the authoritative transfer occurs. One member cannot occupy/reserve multiple seats. Reservations require the boarding lifecycle. A seated controller must match either the reserved or occupied owner and the vehicle’s `ownerControlEpoch`. The vehicle’s own `controlEpoch` is an independent lease generation and does not have to equal the player input generation. An unclaimed vehicle has a null owner control epoch. The tank heading runs counterclockwise from right through up-right, up, up-left, left, down-left, down and down-right; hull facing remains independent.

## Other entities and threats

Enemy words: `id, definitionId, x, y, vx, vy, shapeId, facing, health, mode, stateStartTick, actionInstanceId, actionDefinitionId, modeTicks, supportId, geometryRevision`. The four transform/motion fields and facing are signed. Mode is a bounded definition-owned value 0–31. Enemies are remote authoritative entities; this section is not a full enemy AI checkpoint.

Projectile words: `id, ownerId, actionInstanceId, definitionId, x, y, vx, vy, spawnTick, lifetimeTicks, heading, shapeId`. Transforms/motion are signed; heading is 0–255 and lifetime is positive. A surviving projectile may refer to a source removed earlier; source attribution is not restricted to the current living entity table.

The combat fixture projects grenades in this section with shape `10`, attack definition `5`, their current body position/velocity, and a release tick plus 90-tick fuse. Bounce count and terrain support remain private checkpoint state. Snapshot recipients and pre-commit validation use the negotiated combat shape set, including the knife and grenade shapes.

Dynamic platform words: `id, x, y, vx, vy, shapeId, trajectoryId, trajectoryTick`. Transforms/motion are signed. Compiled trajectory identity and phase let the predictor reproduce deterministic supports rather than inventing velocity-only extrapolation indefinitely.

Threat words: `actionInstanceId, sourceId, definitionId, telegraphTick, activeTick, endTick, x, y, vx, vy, heading, targetId, motion, cancelled, stateVersion, shapeId`. Transforms/motion are signed; motion is `linear, locked, authored`. The interval satisfies `telegraphTick ≤ activeTick < endTick`. Keeping pending/active/cancelled descriptors in a full baseline avoids depending on a missed transient event to explain incoming damage. The actual visible-warning budget and threat timeline are W05/W04 acceptance work.

Contextual knife actions project their authored hand position, facing and shape `9` through windup and the four-tick active window. Consumed target IDs stay in the private strike ledger. Rifle threats retain their committed target/aim and raise/burst interval. Broader enemy telegraph coverage remains unfinished.

## Combat accounting section

Header flag bit 0 appends a versioned combat section after removal IDs; flags other than 0 or 1 are rejected. Flag 0 decodes to `combat: null`, used by controller and synthetic fixtures. Combat snapshots include the section, including when the encounter has completed. All frames and handshakes now require protocol 3.10; there is no compatibility decoder for earlier minors.

| Section offset | Field                                                                            | Encoding |
| -------------- | -------------------------------------------------------------------------------- | -------- |
| 0              | Section version 3, header size 52                                                | 2 × u16  |
| 4              | Next entity ID, next action ID                                                   | 2 × u32  |
| 12             | Encounter receipt cursor, encounter ID, phase                                    | 3 × u32  |
| 24             | Member count 0–256, objective count 0–64, participant count 1–4, area count 0–64 | 4 × u16  |
| 32             | Destructible count 0–32, reserved zero                                           | 2 × u16  |
| 36             | Failure owner, failure tick, reason, cause                                       | 4 × u32  |

Phase is `active, complete, retired, failed`. Failure fields are all zero when absent. Failure tick and every optional tick below use `tick + 1`, reserving zero for null; tick zero is representable. Failure reason is a one-based index into `critical-loss, forbidden-retreat, invalid-pose`; cause is a one-based index into `initial-overlap, residual-overlap, contact-limit, unresolved-contact, retreated, crushed, out-of-bounds`.

The header is followed by 24-byte destructible records: six u32 words `id, definitionId, health, destroyedTick, destroyerId, destroyActionId`. Optional destruction ticks use `tick + 1`; owner/action IDs use zero for null. Live props have positive health and no destruction attribution; destroyed props have zero health, a past destruction tick and an allocated action/known owner. All prop IDs are ordered, unique across gameplay sections, and present in removals exactly when destroyed. The negotiated content supplies their immutable collision rectangles.

Each 32-byte member is eight u32 words: `id, policyFlags, status, activatedTick, resolvedTick, resolution, killerId, reservedZero`. Policy bits are required (1), critical (2), retreat-allowed (4); other bits are invalid. Status is `pending, alive, resolved`. Resolution is null/zero or a one-based index into `killed, retreated, crushed, out-of-bounds, ambient-timeout, checkpoint-retired`. Killer IDs are nullable player IDs. Members retain terminal attribution after their visible enemy records are removed.

Member records are followed by eight-byte objective records (`id, completedTick`), then eight-byte kill credits (`playerId, count`). All three tables have unique ascending IDs. Credits cover the player roster and equal kills attributed by the member ledger. The encounter ID matches the campaign; complete encounters have no unresolved requirement, retired encounters have no unresolved members, and failure fields agree with the failed phase. Allocation cursors exceed every referenced allocated entity/action ID, including removals and projectiles whose owners have disappeared.

The section is `52 + 24 × props + 32 × members + 8 × objectives + 8 × participants + 48 × areas` bytes, at most 12,628. The four-player/two-target fixture adds 148 bytes with no props or active areas, 340 bytes during four shotgun blasts, and up to 724 bytes during twelve flame lobes; the scaffold adds another 24 bytes. Decoder count/length validation happens before allocating tables. Independent Python-struct section goldens cover pending and completed encounters and an attached flame exposure. This section restores accounting after missed transient effects; completing one encounter does not set whole-campaign victory. See [server checkpoint and journal](./combat-checkpoint-v11.md) for the separate private continuation format.

## Validation and baseline ownership

Each entity section is strictly ordered by ascending entity ID, with no ID reused across live sections. Threats are ordered by action instance ID and removals by ID. Live entities cannot also be removed. Player IDs and slots are unique; vehicle component IDs are ordered/unique. A full baseline must include the local player. The decoder rejects unknown loaded shape IDs, mismatched run/socket/geometry, inconsistent acknowledgment/controller state, malformed enums, nonzero padding, excess counts, truncated records and trailing data before returning any entity state.

The room/client adapter must separately enforce monotonic applied snapshot IDs, accepted baselines, event-ring gaps, table/geometry installation and current-socket ownership. Receiving bytes does not authorize applying them to the current game. Full-state baselines reset the event delivery cursor after explicit acceptance; they must not replay obsolete gun sounds. Future gameplay sections such as pickups must extend this declared schema and fixtures before becoming active; arbitrary JSON additions are not a fallback.

## Active shield projection

Enemy definition 4 identifies active shield infantry. Modes 0–5 encode brace, advance, turn, bash, stunned and dead; modes 6–11 retain those phases after the shield has broken permanently. The action ID, timeline ID, start tick and mode age identify the exact continuation. An unstarted pending guard has age zero. The shield is raised in brace/advance and the first 12 bash ticks, lowered during turns and the remaining bash, and absent after break. Integrity amounts, committed target/turn facing and the per-bash hit ledger remain private in archive 10.

The 30-tick bash projects an attached threat with attack 6 and shape 12 from windup through its four active ticks (offsets 12–15). It uses the enemy body as source, a global action identity, committed target and facing, and an authored hand socket. This projection and the shield-break event extend protocol 3.5 without increasing snapshot or event record sizes. See the [private continuation contract](combat-checkpoint-v11.md).

## Authored area exposures

Combat section version 3 appends 48-byte area records after kill credits. Each record contains six u32 fields (`id, ownerId, actionInstanceId, definitionId, spawnTick, endTick`), signed i32 `rect.x, rect.y`, unsigned u32 `rect.w, rect.h, heading`, then u16 `lobe, attached`. Headings are right/up/down/left (0–3), lobe index is 0–3, and attachment is exactly 0 or 1. Positions retain Q256 precision, positive dimensions are at most 65,536 subpixels, endpoints remain in position bounds, and `spawnTick ≤ snapshot.tick < endTick` with at most 120 lifetime ticks.

Records are strictly ordered by source ID then lobe index. Lobes sharing a source also share its player owner, action ID and definition. Area IDs cannot collide with visible entities, retained encounter members or removals. Source and action IDs participate in allocation-cursor validation. There are at most 64 records; the private world separately limits area groups to 16.

These are the actual terrain-clipped damage rectangles for shotgun definition 10 and flame definition 11. Clients draw them directly without reconstructing hit shapes from velocity or guessing clipping from visual particles. An impact can refer to an earlier point along the tick's swept exposure. New emissions and heading changes use endpoint exposure; attached motion sweeps eligible moving hurtboxes. Per-target cooldowns, blocked emission history, retained reach and cancellation state stay in the private archive. Expired or completely clipped lobes have no public rectangle.

The diagnostic scaffold has two fully loaded revisions. The decoder admits a revision from the explicit loaded set only while also checking the complete prop state against its authored definition; the revision equals one plus the number of destroyed props. Within a run, prop IDs/definitions remain fixed, health cannot increase, and destruction time/owner/action cannot change. Removing a support clears its contacts and grounded/ignored-support references without moving bodies. Prediction keeps the existing input queue, installs the validated geometry, restores the accepted actor and replays only unacknowledged commands. Unknown geometry still requires a fresh baseline.
