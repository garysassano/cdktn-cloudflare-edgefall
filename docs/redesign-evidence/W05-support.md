# W05 attack-driven destructible support

The `support` combat scenario adds an authored scaffold over a real gap. Sidearm/HMG shots, blade/blunt hits, blasts and area attacks can damage solid props through the existing ordered impact path. A lethal impact records destruction and removes support at the accepted world boundary. Grounded rifle/shield enemies then fall through ordinary physics and resolve the encounter. This is an engineering fixture for the representative art benchmark; its temporary geometry is not final runtime art.

## Authoritative geometry and attribution

The scaffold occupies logical rectangle `(176,160,152,56)` with eight health, between floor sections ending at x=152 and beginning at x=352. The four players begin on the left floor, while both infantry actors stand on scaffold 104. Horizontal shots strike the scaffold below the infantry rather than damaging an artificial trigger.

Physics uses the complete solid geometry. Attack queries represent the scaffold as a damageable neutral solid, so both friendly and hostile projectiles encounter it and volume queries cannot damage an actor through it. All impacts within a tick see the same geometry. The stable impact order determines the single destruction owner/action. Removed support clears ground and contact references, while preserving body position and velocity; it cannot teleport an enemy into a kill volume. The next tick applies normal gravity.

Geometry revision is derived from committed prop removals. The network client validates the known definitions, health, removed IDs and original destruction attribution before installing a new revision. Its independent input capture and retained command identities continue across that boundary. Reconciliation restores the accepted actor before replaying the unacknowledged tail against the loaded geometry. Unknown, regressed or resurrected geometry is rejected. Checkpoint continue restores authored support only as part of its explicit new run epoch.

Protocol 3.9, combat section 3, archive 10 and recording format 7 reject their predecessors. The new 24-byte prop record retains ID, definition, health, destruction tick, owner and action. `prop-destroyed` uses an ordinary 64-byte acknowledged event; the full snapshot carries the lasting state. Worker bindings, service flow and final media are unchanged.

## Deterministic evidence

Four real input streams each submit two short fire-onset taps at ticks 1 and 25, with every packet duplicated. Eight genuine releases remove the scaffold at tick 35; player 1/action 7 owns the final hit. Both enemies retain y=160 and zero vertical velocity at that boundary, lose support, then advance by the existing 55-subpixel gravity. They cross the lower physical boundary at tick 59. The ledger retains two activations and two out-of-bounds resolutions, with no killer IDs or kill credit. All four players retain three lives and exactly two shots through tick 120.

The portable fixture checks ten checkpoint/journal boundaries covering partial health, the final impact, initial falling, pre-terminal state and terminal state. Snapshot round trips retain identical props and geometry. Tests reject unknown definitions, invalid destruction owners, resurrected props and changed attribution, and exercise loaded-geometry prediction with retained commands. Projectile/volume tests also verify that a neutral solid blocks a target behind it.

The first cross-runtime attempt exposed signed zero in a stationary left-facing enemy's horizontal velocity: Node retained `-0`, while JSON transport returned `0`. The grounded movement assignment now produces canonical zero when speed is zero. The query review also corrected neutral prop team filtering so hostile attacks cannot pass through a solid face.

## Validation and retained artifacts

`CHECKPOINT_DISABLE=1 pnpm check` passes 565 tests across 58 files, lint, asset/content validation, all TypeScript checks, the client/Worker dry run and CDK Terrain synthesis. The 18 existing licensed assets remain unchanged. [Required check log](W05-support-check.log.gz).

Node 24.20.0, Chromium 151.0.7922.34 and local workerd from Wrangler 4.128.0 agree on the 120-tick support trace `f8b1433b` and final hash `fd9904d9`, including 480 duplicate packets and ten checkpoint boundaries. The existing portable regression fixtures also pass. [Runtime report](W05-support-contracts.json.gz). The [initial signed-zero failure excerpt](W05-support-signed-zero-failure.txt) preserves the actual comparison failure; the final source fixes the arithmetic assignment rather than normalizing the verifier's result.

The SQLite proof restores the support scene at eleven boundaries in fresh workerd processes. Every journal commit also attempts an injected transaction failure and verifies an unchanged committed prefix; storage remains bounded to six rows. All earlier combat/life/campaign/recovery regressions in that gate pass. [SQLite report](W05-support-storage.json.gz).

The local inspector uses one actual keyboard and eight separate taps. It exports, resets and imports exact recordings at ticks 35, 66, 67, 68, 80, 90, 91 and 105; support is destroyed at 67 and both falls resolve at 91. [Inspector report](W05-support-inspector.json.gz), [destruction recording](W05-support-recording-67.json.gz), [fall recording](W05-support-recording-80.json.gz), [terminal recording](W05-support-recording-91.json.gz), [inspected falling frame](W05-support-inspector-falling.png).

The automatic four-browser run uses two short keyboard taps per player. Its accepted destruction occurs at tick 40, owned by player 1/action 7; both ordinary falls resolve at tick 64. All four browsers retain three lives and two shots, accept geometry revision 2 and the same removal ledger, and agree on twenty terminal snapshots through snapshot 123 and 33 acknowledged events. Every recorded send stays within six ticks of its validated snapshot. [Browser report](W05-support-network.json.gz), [executed verifier and bundle identity](W05-support-execution.json), [browser log](W05-support-network.log.gz), [damaged support](W05-support-network-damaged.png), [falling enemies](W05-support-network-falling.png). An initial screenshot was taken before the browser received the destruction snapshot; the capture now waits for revision 2 and visible falling time. The final image shows the removed solid and descending bodies.

The browser diagnostics retain 182 host-clock samples with no backward wall-clock step in this short run. They also retain missing `/favicon.ico` responses and canceled admission/session/profile requests, with no page exception, client protocol error or room clock fault. This does not close earlier host-clock failures, sustained CPU/load or network impairment gates. [Diagnostics](W05-support-diagnostics.json.gz). Traces, invocation logs and source maps remain configured, with no live deployment or trace-ingestion proof added here. [Observability scope](observability.md).

The [artifact manifest](W05-support-artifacts.json) binds source and evidence hashes; [independent bundle reconstruction](W05-support-source-verification.json) matches the executed portable, SQLite, Worker and browser bundles. [Secret scan](W05-support-secret-scan.json) covers source and decompressed retained artifacts.

The integrated support/physical-removal gap in the [W05 acceptance audit](W05-acceptance-audit.md) is now covered. Next is the W06 representative original art/audio benchmark and its required human review. Full weapon/vehicle behavior, authored Harbor/Foundry/Carrier, production v3, results/outbox/rematch, deployed telemetry/timing and broader impairment/host-clock gates remain open. These engineering screenshots do not establish final visual quality or controller feel.
