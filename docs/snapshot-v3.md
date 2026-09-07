# Arcade full snapshots v3.2

The input/handshake contract is in [protocol-v3.md](./protocol-v3.md). This full snapshot format carries exact local controller state, remote entity state, hostile threat descriptors and explicit removals. It is not a checkpoint or replay encoding. Static geometry, textures and definition tables are identified by the negotiated content build and are not resent here. The active product remains v2 until W04 integration.

## Frame header

| Byte offset | Field                          | Encoding                 |
| ----------- | ------------------------------ | ------------------------ |
| 0           | Magic EF (`0x4645`)            | u16                      |
| 2           | Major 3, minor 2               | u8, u8                   |
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

Room mode is indexed from `lobby, loading, playing, intermission, paused-empty, recovering, completed, expired`. The minimum frame is 436 bytes and the base sections can reach 39,128 bytes; the maximum combat section raises the complete frame limit to 47,912 bytes. This hard allocation limit is not the 6 KiB steady-traffic target; W02/W04 must measure representative populated rooms and reduce traffic before accepting the performance gate. No compression or render quantization is implied by this format.

## Record sequence and sizes

The 64-byte header is followed by the records below, in this exact order. All record fields are four-byte little-endian words. Unsigned words are u32, signed fields are i32, booleans are exactly 0 or 1, and nullable IDs use zero for null. Non-null IDs must be positive. Definition/shape table indices fit 1–65,535, except explicitly idle/unset action definitions and static trajectory IDs may be zero. Counters stay below `0xfffff000`; positions are bounded to ±2^24 subpixels and velocities to ±2^16 subpixels per tick. Timer/ammo/health counters are bounded to 65,535. Enum values are zero-based positions in the lists below.

| Section                   | Record bytes | Count            |
| ------------------------- | ------------ | ---------------- |
| Camera/campaign           | 40           | 1                |
| Processed acknowledgments | 40           | Player count     |
| Controlled players        | 292          | Player count     |
| Vehicles                  | 308          | Vehicle count    |
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

A 292-byte player record is: body; `playerId, slot, controlEpoch, life, lifeStartTick, locomotion`; action; `facing, aim, jumpBufferTicks, coyoteTicks, ignoredSupportId, ignoredSupportTicks, invulnerableTicks, reboardCooldownTicks, vehicleSpecialTicks, vehicleId`; weapon; `grenadeStock, grenadeCooldownTicks, meleeCooldownTicks, geometryRevision, health, lives, lastRallyMission`; then five processed edge cursors in input edge-kind order. Facing is signed ±1. Life is `alive, death, respawning, spectating`; locomotion is `grounded, airborne, crouched, seated`; aim is the input aim enum. `lifeStartTick` is an unsigned tick no later than the snapshot tick, independent of the action clock. Death, entry and spectating delays therefore survive baseline reconstruction and action cancellation. Every field of `ControlledActor` is round-tripped without reduced precision.

A 308-byte vehicle record is: body; `definitionId, kind, lifecycle, occupantId, reservedBy, controlEpoch, armor`; action; weapon; component count; eight component slots of `id, health, broken`, with unused slots all zero. Kinds are `tank, walker, aircraft`; lifecycle is `available, boarding, occupied, exiting, destroying, wreck`. Component count is 0–8. Occupants are player body/entity IDs, not profile/player membership IDs. An occupant may remain attached during exit or destruction until the authoritative transfer occurs. One member cannot occupy/reserve multiple seats. Reservations require the boarding lifecycle, and a seated controller and occupied vehicle must agree on ownership/control epoch.

## Other entities and threats

Enemy words: `id, definitionId, x, y, vx, vy, shapeId, facing, health, mode, stateStartTick, actionInstanceId, actionDefinitionId, modeTicks, supportId, geometryRevision`. The four transform/motion fields and facing are signed. Mode is a bounded definition-owned value 0–31. Enemies are remote authoritative entities; this section is not a full enemy AI checkpoint.

Projectile words: `id, ownerId, actionInstanceId, definitionId, x, y, vx, vy, spawnTick, lifetimeTicks, heading, shapeId`. Transforms/motion are signed; heading is 0–255 and lifetime is positive. A surviving projectile may refer to a source removed earlier; source attribution is not restricted to the current living entity table.

Dynamic platform words: `id, x, y, vx, vy, shapeId, trajectoryId, trajectoryTick`. Transforms/motion are signed. Compiled trajectory identity and phase let the predictor reproduce deterministic supports rather than inventing velocity-only extrapolation indefinitely.

Threat words: `actionInstanceId, sourceId, definitionId, telegraphTick, activeTick, endTick, x, y, vx, vy, heading, targetId, motion, cancelled, stateVersion, shapeId`. Transforms/motion are signed; motion is `linear, locked, authored`. The interval satisfies `telegraphTick ≤ activeTick < endTick`. Keeping pending/active/cancelled descriptors in a full baseline avoids depending on a missed transient event to explain incoming damage. The actual visible-warning budget and threat timeline are W05/W04 acceptance work.

## Combat accounting section

Header flag bit 0 appends a versioned combat section after removal IDs; flags other than 0 or 1 are rejected. Flag 0 decodes to `combat: null`, used by controller and synthetic fixtures. Combat snapshots include the section, including when the encounter has completed. All frames and handshakes now require protocol 3.2; there is no compatibility decoder for earlier minors.

| Section offset | Field                                                                          | Encoding |
| -------------- | ------------------------------------------------------------------------------ | -------- |
| 0              | Section version 1, header size 48                                              | 2 × u16  |
| 4              | Next entity ID, next action ID                                                 | 2 × u32  |
| 12             | Encounter receipt cursor, encounter ID, phase                                  | 3 × u32  |
| 24             | Member count 0–256, objective count 0–64, participant count 1–4, reserved zero | 4 × u16  |
| 32             | Failure owner, failure tick, reason, cause                                     | 4 × u32  |

Phase is `active, complete, retired, failed`. Failure fields are all zero when absent. Failure tick and every optional tick below use `tick + 1`, reserving zero for null; tick zero is representable. Failure reason is a one-based index into `critical-loss, forbidden-retreat, invalid-pose`; cause is a one-based index into `initial-overlap, residual-overlap, contact-limit, unresolved-contact, retreated, crushed, out-of-bounds`.

Each 32-byte member is eight u32 words: `id, policyFlags, status, activatedTick, resolvedTick, resolution, killerId, reservedZero`. Policy bits are required (1), critical (2), retreat-allowed (4); other bits are invalid. Status is `pending, alive, resolved`. Resolution is null/zero or a one-based index into `killed, retreated, crushed, out-of-bounds, ambient-timeout, checkpoint-retired`. Killer IDs are nullable player IDs. Members retain terminal attribution after their visible enemy records are removed.

Member records are followed by eight-byte objective records (`id, completedTick`), then eight-byte kill credits (`playerId, count`). All three tables have unique ascending IDs. Credits cover the player roster and equal kills attributed by the member ledger. The encounter ID matches the campaign; complete encounters have no unresolved requirement, retired encounters have no unresolved members, and failure fields agree with the failed phase. Allocation cursors exceed every referenced allocated entity/action ID, including removals and projectiles whose owners have disappeared.

The section is `48 + 32 × members + 8 × objectives + 8 × participants` bytes, at most 8,784. The current four-player/two-target combat fixture adds 144 bytes. Decoder count/length validation happens before allocating tables. Independent Python-struct section goldens cover pending and completed encounters. This section restores accounting after missed transient effects; completing one encounter does not set whole-campaign victory. See [server checkpoint and journal](./combat-checkpoint-v2.md) for the separate private continuation format.

## Validation and baseline ownership

Each entity section is strictly ordered by ascending entity ID, with no ID reused across live sections. Threats are ordered by action instance ID and removals by ID. Live entities cannot also be removed. Player IDs and slots are unique; vehicle component IDs are ordered/unique. A full baseline must include the local player. The decoder rejects unknown loaded shape IDs, mismatched run/socket/geometry, inconsistent acknowledgment/controller state, malformed enums, nonzero padding, excess counts, truncated records and trailing data before returning any entity state.

The room/client adapter must separately enforce monotonic applied snapshot IDs, accepted baselines, event-ring gaps, table/geometry installation and current-socket ownership. Receiving bytes does not authorize applying them to the current game. Full-state baselines reset the event delivery cursor after explicit acceptance; they must not replay obsolete gun sounds. Future gameplay sections such as pickups must extend this declared schema and fixtures before becoming active; arbitrary JSON additions are not a fallback.
