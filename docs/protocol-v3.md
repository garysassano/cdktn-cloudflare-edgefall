# Arcade protocol v3.0

This is the implemented input and acknowledgment wire contract, currently isolated from the active v2 game. All integers are little endian. Counters never wrap and must remain below `0xfffff000`; rotate connection epochs or establish a controlled new run before exhaustion. The handshake binds a controlling socket to one run/player and independently checks simulation/content/presentation identities. Unknown fields, versions, flags, reserved bits, enum values and incompatible identities fail closed.

## Input frame

| Header offset | Field                                          | Type    |
| ------------- | ---------------------------------------------- | ------- |
| 0             | Magic `0x4645` (`45 46`, EF)                   | u16     |
| 2             | Major 3, minor 0                               | 2 × u8  |
| 4             | Type 1, flags 0                                | 2 × u8  |
| 6             | Exact total byte length                        | u16     |
| 8             | Nonzero run epoch                              | u32     |
| 12            | Nonzero connection epoch                       | u32     |
| 16            | Nonzero packet sequence                        | u32     |
| 20            | Applied snapshot acknowledgment, zero if none  | u32     |
| 24            | Contiguous consumed event cursor, zero if none | u32     |
| 28            | Command count, 0–3                             | u8      |
| 29            | Reserved zero                                  | 3 bytes |

A zero-command frame acknowledges delivery only. It must never renew control liveness. Each command follows the previous command's edge records without padding.

| Command offset | Field                                   | Type |
| -------------- | --------------------------------------- | ---- |
| 0              | Nonzero sequence                        | u32  |
| 4              | Client fixed-step tick hint             | u32  |
| 8              | Nonzero on-foot/seat control epoch      | u32  |
| 12             | Held bits                               | u16  |
| 14             | Aim: 0 horizontal, 1 up, 2 down request | u8   |
| 15             | Edge count, 0–8                         | u8   |
| 16             | Reserved zero                           | u32  |

Held bits 0–5 are left, right, up, down, fire, and vehicle-special. All higher bits are invalid. The controller resolves opposing directions and legal ground/air aim. Contiguous commands within a frame have consecutive sequence and client tick values. The room must also enforce continuity across frames; receipt does not authorize extra movement steps.

| Edge offset | Field                                                                | Type    |
| ----------- | -------------------------------------------------------------------- | ------- |
| 0           | Kind: 1 jump, 2 grenade, 3 interact, 4 vehicle-special, 5 fire-onset | u8      |
| 1           | Flags/reserved zero                                                  | 3 bytes |
| 4           | Nonzero edge ID                                                      | u32     |

Edge IDs increase independently per kind within the run/player/connection epoch, with maximum forward advance 256. Discarded unsubmitted input can leave edge-ID gaps but cannot leave command sequence holes. A fire-onset and held-fire request in the same consumed command produce one attempt, not two shots. Cooldown/no-ammo rejections are processed and acknowledged; they cannot later release an unexpectedly queued shot.

Frame length is `32 + sum(20 + 8 * edgeCount)` with a maximum of 284 bytes. The decoder validates size before allocation/reads, validates the entire bounded temporary frame, checks the exact final offset and returns commands only on success. Golden byte fixtures in `test/fixtures/protocol-v3/input-golden.json` were independently packed using Python `struct` according to these tables, without calling the TypeScript codec.

## Processed acknowledgment record

Ten consecutive u32 values form a 40-byte record: player ID, connection epoch, control epoch, last processed command sequence, its applied/rejected server tick, then the five edge high-water marks in edge-kind order. The first three values are nonzero; processing cursors may be zero. This record is a snapshot section, not a standalone receipt acknowledgment. A stale socket or mismatched player cannot advance the current acknowledgment.

## Runtime work still required

Full snapshot framing and per-entity fixed record schemas are not implemented by the input codec. Wire decoding also does not enforce immutable duplicates across frames, queue timing, one-command-per-server-tick application, stale-input neutralization, per-connection event acknowledgment limits, effect deduplication or recovery. These need the W01/W04 command stream and snapshot runtime, with their own regression fixtures. The active Worker still advertises v2 until that runtime is ready.
