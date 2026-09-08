# Weapon material responses and inspector

All eight combat action families now share authored surface responses: sidearm, HMG, shotgun, rocket, flame, laser, contextual knife and grenade. The new `material-lab.html` inspector runs those real actions against a two-pixel barrier and stationary or patrolling calibration targets, with one keyboard controlling the selected party. It supports retained short taps, stepping, rendered geometry inspection and complete recording export/import. It uses engineering shapes and creates no final gameplay assets.

Calibration targets have 32 HP so repeated damage remains observable. Ordinary campaign infantry health is unchanged. Firearms start with their registered pickup ammunition; one accepted onset spends one round or charge. Knife arbitration and crouched grenade release, bounce and fuse use the existing combat kernel. The material matrix exercises these authored horizontal/crouched arrangements; it does not claim every directional pose or mission introduction is complete.

## Surface policy

| Surface      | Prop damage response                                      | Damage propagation                                            |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| Concrete     | Immune                                                    | Blocks every material                                         |
| Timber       | Unit scale for every material                             | Blocks every material                                         |
| Armor steel  | Explosive ×1, energy ×2; other materials ×0               | Blocks every material                                         |
| Open grating | Bullet, explosive, energy and blunt ×1; heat and blade ×0 | Passes blast, heat and energy; blocks bullet, blade and blunt |

These are authored game rules. Actor movement and released rocket/grenade bodies still collide with physical grating. A rocket bursts at that contact while its blast may propagate through the openings. Beams can damage the grating and continue into distinct targets; overlapping hurtboxes still share one entity hit budget. Impact notices retain incoming attack damage, while committed prop health applies the surface scale.

A clipped volume now damages the exact solid face it reaches. Corner-only contact and ordinary body grazes remain excluded. Contacted flame lobes preserve their propagation limit after a solid moves or is destroyed; a newly emitted lobe may advance through the cleared space. A focused regression caught the missing solid-face contact before this correction, and the failing and passing observations are retained.

## Validation

`pnpm check` passes **816 tests across 76 files**, including ten material tests. Lint, asset/art/audio validation, compiled content, TypeScript, client/Worker dry-run and CDKTN synthesis also pass. The material tests cover moving blast occlusion at the beginning, midpoint and end of a tick; swept contact with thin moving grating; distinct beam penetration; rocket contact; cooperative cover destruction; incompatible content; and malformed or altered recordings.

| Harness                          | Result                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node, Chromium and local workerd | Identical 128-case matrix: eight action families × four surfaces × two target motions × one/four players; 384 JSON continuation boundaries and complete local recording replay |
| Material browser inspector       | 128 real keyboard recordings, all 15,360 noninitial state boundaries, 1,234 rendered geometry boundaries, 65 geometry screenshots and one full inspector screenshot            |
| Inspector input/import controls  | Two-player pointer Step retains a short tap; blur clears input and repeat cannot recreate it; rejected state/fingerprint imports preserve the current world                    |
| Existing combat inspector        | Complete suite passes, including destructive support, area attacks, rockets, laser and pickups                                                                                 |
| Existing SQLite diagnostic suite | Archive 16 recovery passes, including eleven fresh-process scaffold boundaries, twenty laser boundaries and twenty-one pickup boundaries with rollback checks                  |
| Four-client scaffold room        | Two real fire taps per player destroy support at tick 40; all clients agree on twenty shared terminal snapshots and the retirement of supported pickup 620                     |
| Complete local Breakwater routes | Format 4 solo/two/four-player recordings reach victory at ticks 3,054 / 3,080 / 2,989, with 5 / 10 / 20 claims and exact Node/browser replay                                   |

The network run resolves the two falling enemies without kill credit. All four players keep three lives, each client sees one destruction event, and the supported item retires at tick 40 without a pickup grant. The regression exposed an older harness assertion that omitted item 620 from removed entities; the corrected assertion verifies both the authoritative retirement and every client's public state. Its failure evidence is retained.

Breakwater verification compares all 9,123 noninitial simulation/visual boundaries and 84 rendered supply-count checkpoints. The material changes move scaffold destruction from tick 1,522 to 1,540 in the solo/two-player routes and from 1,429 to 1,435 in the four-player route. Current victory timings replace the preceding engineering baseline; they are simulation route outcomes, not CPU measurements. Existing media is reused, and no new review movies were produced.

Two unconstrained full-check attempts exceeded existing five-second replay-test limits, despite an isolated eleven-test pass and an intervening complete-suite pass. Vitest now uses at most four workers to bound contention between CPU-heavy replay matrices; the five-second test limits remain unchanged. The cross-runtime suite took 37.9 seconds in Node, 31.6 seconds in the local workerd request and 30.4 seconds in Chromium; the existing 60-second whole-suite workerd bound remains unchanged. These durations do not establish deployed per-tick performance.

## Formats, evidence and remaining work

[Archive 16](../combat-checkpoint-v16.md), combat simulation/recording **13** and Breakwater mission/recording **4** reject earlier experimental continuation. Protocol **3.13** and combat snapshot section **4** retain their existing layouts. The content identity now binds the surface registry and each destructible's material. Existing diagnostic scaffold and Breakwater props explicitly use timber.

The standalone material inspector uses recording format **1**, including its definition, input sequence, local compatibility fingerprint and canonical final state. Its calibration stages are not yet registered diagnostic room scenarios or accepted durable checkpoints. The 384 material JSON continuations must not be described as material-specific SQLite or durable archive proof.

The immutable [artifact manifest](materials-2026-09-08/artifacts.json) binds **393 repository source files**, **one dependency** and **253 artifacts totaling 8,839,090 bytes**. Seven rebuilt bundles match the tested outputs: portable contracts, SQLite Worker, diagnostic room Worker, combat inspector, network client, material inspector and Breakwater. The package retains compressed reports, all 128 material recordings, selected mission/scaffold recordings and screenshots, the curation script and observed failure controls. Manifest SHA-256 is `912fd7cc6bb529352ef7dd407b03cc564fb444695f895a478839bcebfa003c0f`. [Material cases](materials-2026-09-08/material-cases.json) and [mission results](materials-2026-09-08/mission-results.json) provide compact entry points.

Wrangler source and generated deployment configuration enable traces and logs at sampling 1, invocation logs and source-map uploads, following [Cloudflare's tracing configuration](https://developers.cloudflare.com/workers/observability/traces/). Live ingestion and deployed room cadence remain unverified.

This completes the local material-response and inspector checkpoint. Material-specific diagnostic room/public-snapshot/cold-process integration, broader directional and mission weapon coverage, final media, production v3, the full campaign and human acceptance remain unfinished. The existing W06 review remains pending; W07 as a whole is open.
