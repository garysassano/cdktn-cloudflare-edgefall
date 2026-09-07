# W05 contextual knife and grenade progress

This increment adds contextual knife attacks and discrete grenade throws to the deterministic combat world, the local inspector, and the four-browser diagnostic room. W05 remains open: active shield counterplay, the representative shotgun/flame fixture, tank interaction, authored missions and final media are unfinished. The production game still uses v2.

## Behavior and contracts

At the next legal fire action, exposed infantry within the facing knife volume selects an 18-tick melee action. It spends no firearm ammo or shot ordinal. The authored marker activates at offset 5 for four ticks; a private per-target hit ledger prevents repeated damage within that window. Moving hurtboxes use swept contact, concrete blocks the contact ray, and a facing shield prevents body damage. The forward volume begins at the actor root, so overlapping infantry remain eligible; the cover ray starts at that root at hand height, even when the hand extends beyond thin cover. Standing/crouched pose changes preserve the action clock and marker cursor.

A grenade edge takes priority over simultaneous fire, spends one stock at action start, releases at the authored hand at offset 4 and finishes its throw recovery at offset 20. Standing and crouched throws use different bounded integer velocities. Terrain movement allows at most three bounces; the 90-tick fuse starts at release. The blast tests the nearest hurtbox point against its radius, then applies concrete/shield occlusion and stable damage ordering. A death before release cancels the pending marker; an already released grenade survives its owner's death. Markers released on the same tick as a hit remain released.

Protocol **3.4** adds `melee`, `throw`, `action-sound` and `explosion` events without increasing the 64-byte event record. They retain authority-owned action IDs and have no firearm prediction confirmation key. Knife threats and grenade bodies/fuses are included in the negotiated combat snapshot shapes. Archive **5** retains active hit ledgers, grenade bodies/bounces/fuses, consumed action markers, and existing rifle/life/campaign continuation; earlier archives are rejected. Local input recordings use format **2**. See the [event contract](../events-v3.md), [snapshot contract](../snapshot-v3.md), and [checkpoint contract](../combat-checkpoint-v5.md).

## Verification

| Gate                 | Observed result                                                                                                                                                                                    | Retained output                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Required check       | 477 tests in 48 files; lint, assets/content, all TypeScript targets, production bundle/dry run and CDKTN synthesis pass                                                                            | [Check](W05-foot-check.log.gz)                     |
| Portable replay      | Node, Chromium and local workerd agree for three 120-tick four-player fixtures: knife, standing grenade and crouched grenade; each retransmits all 480 packets                                     | [Runtime report](W05-foot-contracts.json.gz)       |
| Private recovery     | 22 checkpoint/replay boundaries cover windup, hand release, active melee hit history, bounces and the last fuse tick; standing grenades release at 5 and detonate at 95                            | [Runtime report](W05-foot-contracts.json.gz)       |
| SQLite restart       | Four cold-process boundaries per action, including knife hit tick 51 and grenade tick 94; every journal segment first rolls back an injected transaction failure without changing its saved prefix | [Storage report](W05-foot-storage.json.gz)         |
| Four-browser knife   | Actual move/fire keys produce knife markers at 59–59, two total credited kills by 75, and 15 common snapshots after combat; duplicate event delivery creates no duplicate effect                   | [Browser report](W05-foot-melee-browser.json.gz)   |
| Four-browser grenade | Four actual keyboard throws release at 10 and detonate at 100, preserve nine stock each, credit two kills once, and produce 15 common snapshots after combat                                       | [Browser report](W05-foot-grenade-browser.json.gz) |
| Local inspector      | Actual keyboard taps, format-2 export/import during an active hit window and grenade flight, and exact fuse expiry pass alongside existing gun/life/replay checks                                  | [Inspector report](W05-foot-lab.json.gz)           |

The portable final hashes are `8a711413` (knife), `e7cf347b` (standing grenade) and `49e11010` (crouched grenade). SQLite preserves grenade tick 94/hash `369dcd67` across a fresh process, then replays detonation once through tick 110/hash `563c2fa7`. These are deterministic engineering fixtures, not measurements of authored mission difficulty or sustained room CPU.

Inspected screenshots show the replicated knife volume and grenade flight, plus paused local knife contact at tick 51 and blast radius at tick 95. The shapes remain engineering overlays: [network knife](W05-foot-melee-action.png), [network grenade](W05-foot-grenade-action.png), [local active knife](W05-foot-melee-local.png), [local blast](W05-foot-grenade-local.png).

## Retained failures and diagnostics

The first browser attempt stopped at completed tick 52 with `Snapshot shape is not loaded`. The room's pre-commit encoder still used the controller-only shape set; switching that combat path to the negotiated combat shapes fixed the failure. The failed candidate did not publish a new world tick. The [failure](W05-foot-melee-first-failure.json.gz), [client state](W05-foot-melee-first-clients.json.gz), and [diagnostics](W05-foot-melee-first-diagnostics.json.gz) are retained from before that correction.

The growing cross-runtime suite also exceeded its previous five-second HTTP deadline. The [original timeout](W05-foot-runtime-timeout.log.gz) is retained. The harness now records per-runtime elapsed time, removes stale success reports and writes phase-specific failures; its whole-suite HTTP deadline is 20 seconds. The final run took 6,954 ms in Node, 5,886 ms for the workerd request, and 5,605 ms in Chromium. These durations include the whole conformance workload and are not game-tick CPU measurements. Gameplay clock, catch-up, input-lead and persistence-backlog guards were not relaxed.

Final [knife](W05-foot-melee-diagnostics.json.gz) and [grenade](W05-foot-grenade-diagnostics.json.gz) diagnostics retain favicon 404s and canceled admission/session/profile requests. Neither final run has a page exception, client protocol error or room clock fault. Existing host-clock discontinuities and six-tick input-lead findings remain unresolved; see [observability](observability.md).

Wrangler still explicitly enables traces, invocation logs and source-map upload, with sampling 1. Cloudflare requires the [separate tracing switch](https://developers.cloudflare.com/workers/observability/traces/). The prior [sanitized account lookup](W04-continue-cloudflare-read.json) found no accessible Edgefall deployment; this increment performs no live deployment or trace retrieval.

## Remaining work

Continue with active shield counterplay, the representative shotgun/flame lane and tank boarding/driving/ejection. Moving-platform crush behavior and launch momentum for grenades need an explicit policy and acceptance fixture. Complete the W06 representative style benchmark and human review before remaining final asset production, then weapon/tank coverage and authored Harbor/Foundry/Carrier missions. Production v3, results/outbox/rematch, staging load and human playtest gates remain open.

[Artifact and source hashes](W05-foot-artifacts.json) bind the final passing worktree to the reports. Report commits identify the base checkout; source and bundle digests identify the tested additions. Earlier failure artifacts describe the pre-correction attempts above.
