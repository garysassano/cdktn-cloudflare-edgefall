# W05 active shield infantry

The mixed `guard` engineering scenario now runs an active shield enemy alongside a rifleman through the deterministic world, local inspector and four-browser diagnostic room. The shield has separate integrity and an exposed one-hit body. W05 remains open for representative shotgun/flame coverage and tank interaction; authored missions, final media and production v3 remain unfinished.

## Behavior and continuation

A guard braces for 24 ticks and advances at one pixel per tick for up to 36 ticks. Stable distance/ID acquisition may interrupt those phases for a turn or close bash. Grounded physics handles its supports, falling and wall/ledge stops; boundary contact cannot silently reverse its committed facing. A turn lasts 18 ticks, lowers the shield, and flips facing once at offset 9. The guard does not follow players vertically.

Bash commits to a target and facing for 30 ticks: 12 windup, four active and 14 recovery. The shield is raised during windup and lowered afterward. An attached blunt volume uses the authored hand socket, terrain occlusion, hostile hurtbox eligibility and a sorted per-action hit ledger. Jumping or leaving the volume avoids it. Death cancels an unreleased bash; already released same-tick attacks retain the shared ordered-damage rule.

Integrity starts at two. Frontal bullets and blades spend zero integrity, explosives spend two, and heat/blunt spend one. Breaking the shield emits once and starts a 36-tick stun without damaging body HP. The shield stays broken after stun. Exposed flanks, turn/bashing openings and subsequent body hits still kill ordinary infantry with one hit; no extra infantry HP substitutes for counterplay. Heat is a material-policy test here; a complete flame weapon remains future work.

Protocol **3.5** adds `shield-break` and the shield phase/bash projections without enlarging the 64-byte event record. Enemy definition 4 projects phase, intact/broken state and action age; shape 12 describes bash reach. Archive **6** retains integrity, committed target/turn, the action marker cursor and per-bash hit IDs. The content digest includes the shield policy. Earlier experimental archives and protocol minors are rejected, and local combat recordings use format **3**. See the [snapshot](../snapshot-v3.md), [event](../events-v3.md) and [checkpoint](../combat-checkpoint-v6.md) contracts.

## Verification

| Gate                 | Observed result                                                                                                                                                                               | Evidence                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Required checks      | 485 tests in 49 files; lint, assets/content, all TypeScript targets, client/Worker dry run and CDKTN synthesis pass                                                                           | [Check output](W05-shield-check.log.gz)                                                   |
| Portable simulation  | Node, Chromium and workerd agree on two 180-tick, four-player input replays, each including 720 duplicate packets                                                                             | [Runtime report](W05-shield-contracts.json.gz)                                            |
| Private continuation | 17 checkpoint/journal boundaries cover windup, active hits, both sides of the turn marker, break and stun expiry; snapshot/event frames round-trip                                            | [Runtime report](W05-shield-contracts.json.gz)                                            |
| SQLite recovery      | 19 cold-process boundaries preserve exact hashes and private guard state; every segment first fails inside its transaction before unchanged-prefix verification and successful commit         | [Storage report](W05-shield-storage.json.gz)                                              |
| Four browsers        | Actual keyboard movement/jump/crouch/grenade/fire clears the mixed encounter by observed tick 160; all four players retain three lives, with 15 shared snapshots and 79 common event receipts | [Browser report](W05-shield-browser.json.gz)                                              |
| Inspector            | Real keyboard input avoids bash, breaks the shield, exports/imports tick 95 exactly and retains the break through stun expiry; gun, knife, grenade and life regressions also pass             | [Inspector report](W05-shield-lab.json.gz), [recording](W05-shield-lab-recording.json.gz) |

The portable bash replay ends at hash `8f832522`; the grenade/break/completion replay ends at `f65d160a`. Three players are hit once by the first bash at tick 30 while the fourth has already left that volume. In the counterplay replay, all players retain three lives at the tick-95 shield break; guard HP remains one, stun lasts through tick 130, and later body hits clear the encounter. These are admitted-input fixtures, with no injected enemy damage or teleported recovery states.

The browser run records one shield break at tick 100 and two credited enemy kills. The client with injected duplicate event delivery records 199 duplicates and only one break effect. Its received guard snapshot shows broken/stunned mode 10 with age 14. Inspected screenshots show [bash windup](W05-shield-windup.png), [the replicated broken shield](W05-shield-broken.png), [the cleared encounter](W05-shield-cleared.png), and local [windup](W05-shield-local-34.png), [turn](W05-shield-local-66.png) and [break/blast](W05-shield-local-95.png). All are explicitly engineering overlays.

## Failures retained and corrected

The first SQLite run failed at tick 56 with `Invalid combat durable metadata`. The writer accepted short segments but compacted only after sixty elapsed ticks, while the reader allowed four segments. The fifth short segment exceeded the six-row recovery view. Storage now compacts before adding a fifth segment as well as at the sixty-tick boundary. The regression proves checkpoint replacement at tick 56, a maximum of six rows, transaction rollback and exact cold replay. The [original storage failure](W05-shield-storage-first.log.gz) is retained.

The first browser fight completed with all players unharmed, but its verifier expected the original four throws in the server's final event window. Those records had correctly aged out of the 120-tick retention window. The verifier now checks the captured release boundary and all clients' received histories, preserving the bounded server policy. The original [failure](W05-shield-browser-first-failure.json.gz), [client receipts](W05-shield-browser-first-clients.json.gz), [diagnostics](W05-shield-browser-first-diagnostics.json.gz) and [log](W05-shield-browser-first.log.gz) are retained.

Final [browser diagnostics](W05-shield-diagnostics.json.gz) retain favicon 404s and canceled local admission/session/profile requests. The final run has no page exception, client protocol error, persistence failure or room clock fault. The conformance suite took 8,610 ms in Node, 7,280 ms for the workerd request and 7,094 ms in Chromium. Those are whole-suite durations, not per-tick CPU measurements. Gameplay clock, catch-up, input-lead, event-retention and persistence-backlog limits remain unchanged.

Wrangler still explicitly enables traces and invocation logs with sampling 1, plus source-map upload. This increment uses local diagnostics and performs no Cloudflare deployment or live trace retrieval. The prior sanitized account lookup found no accessible Edgefall deployment; [observability notes](observability.md) retain that limitation and the unresolved host-clock/input-lead findings.

## Next work

Continue W05 with the representative shotgun/flame fixture and lab tank boarding, driving, jumping, aim, reservation and safe ejection. Resolve the grenade moving-platform crush and launch-momentum policies. The W06 representative art/audio benchmark and human review precede remaining final asset production. Full weapon/vehicle coverage, authored Harbor/Foundry/Carrier missions, production v3, results/outbox/rematch, staging profiles and human playtests remain open.

[Artifact and source hashes](W05-shield-artifacts.json) bind the tested worktree to this evidence. Reports name the base commit; source and bundle digests identify the additions. Failure artifacts precede the corrections described above.
