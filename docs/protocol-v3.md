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

## Executable command-stream contract

`InputStream` owns one controlling connection and binds client tick zero to the server baseline tick plus one. It admits at most three contiguous commands per packet, at most six mapped ticks ahead, and at most 120 queued commands. Packet and command sequences start at one. It retains 180 immutable packet fingerprints and up to 300 accepted commands (120 pending plus 180 history); a duplicate older than retained proof requires resynchronization. A changed duplicate, reused edge, sequence gap, unissued control epoch or invalid delivery acknowledgment stops that stream before any partial admission or processing acknowledgment.

Admission copies the complete batch and validates its final command before committing changes. Duplicate and acknowledgment-only packets never renew the input lease. The server supplies monotonic time/tick values; the stream never reads a wall clock. Commands older than 15 mapped ticks or 250 ms since receipt are consumed as explicit no-ops; missing commands repeat only held state until the 250 ms lease expires, never action edges. Repeated internal input uses the last command identity (or zero before any command), is marked `repeatedHeld`, and has no submitted command. It is journal data, not a wire InputCommand to feed back through the network decoder.

`processTick` permits one call per server tick and invokes the simulation callback before advancing acknowledgment cursors. Every delivered edge needs one result (`applied`, `cooldown`, or `unavailable`); stale/old-control edges receive synthetic rejection results while their normalized intent is neutral. The journal retains both original submitted intent and normalized applied intent, per-edge outcomes, and explicit expiry decisions. An exception or incomplete result stops the stream without acknowledging the uncertain tick; the room must recover rather than retry possibly duplicated effects.

After an authoritative seat outcome, the adapter advances `controlEpoch` once before subsequent input acceptance/publication; doing so clears old held intent. On reconnect/resynchronization, construct a fresh stream under a newly approved connection epoch and baseline. The old socket must not be routed to that new stream. `recordSent` records actually delivered snapshot IDs and event-prefix cursors, preventing acknowledgments of unsent state. The complete snapshot section layout and validation are in [snapshot-v3.md](./snapshot-v3.md).

## Coordinated world commit

`InputStream.processWorldTick` stages the normalized input and proposed consumption acknowledgment for every controlling socket in stable player order, then locks those streams against reentrant mutation. Its synchronous evaluator builds and validates a candidate world and returns exactly one edge-outcome list per player. Only after every outcome validates does the transaction remove queued commands and advance all processed cursors. The room then installs the candidate state and exposes its events/snapshots. `processTick` uses the same path for a single owner.

An evaluator, encoding or edge-outcome failure leaves all participating queues and acknowledgments unchanged and stops those streams until a fresh baseline. Invalid read-only timing/cohort preconditions do not execute the world and can be corrected by the caller. Evaluators must avoid external mutation and I/O; the transaction cannot undo arbitrary callback side effects or provide durable database atomicity. The loopback controller, synthetic and combat room workloads use this boundary. The combat workload stages its event history and cursor with the world, validates each recipient's binary snapshot and new events before committing, then publishes only the accepted event prefix.

## Snapshot-paired input mapping

The separate [gameplay-event contract](./events-v3.md) defines binary event batches, retention, contiguous acknowledgment and explicit full-baseline repair.

Handshake capability `0` retains the original baseline-plus-client-tick mapping. Capability `1` enables a bounded JSON `input-mapping` control message immediately before each binary snapshot, including the initial baseline. The controller laboratory requires capability `1`. Capability `3` combines input mapping with acknowledged gameplay events (bit `2`) and is required by the combat laboratory; standalone `2` and unknown combinations fail closed. Input, acknowledgment and full-snapshot binary layouts remain unchanged.

The control message has exactly `type: "input-mapping"`, `runEpoch`, `connectionEpoch`, `playerId`, `snapshotId`, `snapshotTick`, `nextSequence` and `nextCommandTick`. The decoder rejects messages above 512 UTF-8 bytes, unknown fields, invalid counters and a next-command tick other than `snapshotTick + 1`. All counters except snapshot tick are nonzero. The receiver pairs it with exactly the named snapshot and owner and requires `nextSequence = lastProcessedSequence + 1`. A missing, repeated, mismatched or unsolicited mapping requires a fresh baseline.

Pending command sequence `s` is replayed at `nextCommandTick + s - nextSequence`. This mapping states the earliest sequential application after that snapshot; further absent input can cause a later server mapping. Its offset cannot regress. Drift beyond six ticks from the original baseline requires fresh input synchronization; an observer with no pending commands may continue restoring snapshots, but cannot resume input under that excessive drift. The server still applies at most one command per tick, and receipt/admission, stale-command, edge-identity and control-lease limits are unchanged. The client cannot rewrite sequence, client tick or action edge IDs to repair its own timing.

Binary snapshot byte metrics exclude this additional control message. Diagnostic `inputMappingBytes` reports its UTF-8 payload separately; neither metric includes WebSocket/TLS framing.

## Integration work still required

The active Worker still advertises v2. W04 must connect the stream to the real ordered world step, current-socket/membership ownership, wall-clock-to-tick journal, event ring, full-baseline installation, complete prediction and backpressure. W02 must verify clocks, storage cost and traffic budgets with actual room workloads. Codecs and a conformance fixture cannot establish controller feel, remote cadence or replay recovery.
