# Pickup integration in the authoritative room

The combat laboratory and diagnostic Durable Object now apply individual weapon supplies inside the accepted world/input transaction. Four players can share five stations covering HMG, shotgun, flame, rocket and laser. Each station contains one unreserved item per participating player. Contact-entry latches survive persistence, so holding Fire while overlapping a pile does not consume the remaining items. A rear item expires at tick 24, and the scaffold scenario retires its supported item when the scaffold breaks.

The existing [pickup kernel and Breakwater mission proof](W07-weapon-pickups.md) establishes swept contact ordering, capped ammunition, single winners and preserved firearm identity. This increment carries those results through the diagnostic wire, exact archives, SQLite rollback/restarts and real keyboard clients. These laboratory overlays are engineering graphics; remaining final media stays behind the pending W06 review.

## Contracts and recovery

Protocol **3.13** adds a bounded 16-byte item record to combat snapshot section **4**. Clients receive availability, resolution tick and claimant; private contact latches remain in the authoritative archive. Resolved items retain their original attribution and cannot reappear within a run. The maximum complete snapshot is **53,084 bytes**.

Acknowledged pickup events use kind **11** and 96-byte records, with at most 64 records in a **6,176-byte** frame. Each grant identifies the source, item, claim, receiving player, previous/new weapon and ammunition. A passive claim uses action ID zero and does not allocate a firearm action. Duplicate delivery never grants inventory again. Delayed effects use receipt time so an already-old claim can still be drawn once when it arrives.

[Archive 15](../combat-checkpoint-v15.md) and simulation/recording format **12** retain exact items, entry latches and current claim notices. Validation binds claims to their item resolution, registered content and terminal player inventory, including successive grants in one tick. Ordinary recovery preserves inventory and latches while establishing a fresh event generation. Paid continue resets checkpoint supplies under the new run epoch and restores baseline equipment; supplies whose absolute expiry has passed stay expired. Breakwater mission/recording format **3** explicitly rejects the previous embedded combat layout.

## Validation

`pnpm check` passes **806 tests across 75 files**, including twelve room pickup cases and an independently encoded pickup snapshot fixture. Coverage includes accepted four-stream contention, public and private continuation, wire field layout, delayed/duplicate delivery, invalid grants and latches, terminal attribution, recovery, transaction aborts, support loss, full-inventory re-entry and a real party wipe followed by paid continue. Asset, art, audio, compiled content, TypeScript, client/Worker dry-run and CDKTN synthesis checks also pass.

| Harness                                | Observed result                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node / Chromium / local workerd        | Identical 150-tick four-controller route, twenty unique claims, 600 duplicated input packets and twenty archive/journal continuation boundaries                                                    |
| SQLite Durable Object                  | Twenty-one saved/restored boundaries in fresh workerd processes, at most six rows; injected journal transaction failures preserve the previous inventory, contacts, events and acknowledged prefix |
| Keyboard combat inspector              | One moving player claims five weapons while idle allies leave fifteen items; fourteen rendered count checkpoints and imported recordings reproduce exact state                                     |
| Four keyboard network clients          | Twenty claims displayed once by every client; thirteen shared terminal snapshots through tick 135, matching availability and inventory                                                             |
| Complete Breakwater browser regression | Format 3 solo/two/four-player recordings reach victory at ticks 3,036 / 3,044 / 2,992 with 5 / 10 / 20 claims and exact replay                                                                     |

The portable route ends with runtime hash `9f303192`, trace hash `9cc7060b` and laser energy `113, 113, 113, 112`; all four players retain three lives. Its 156 gameplay events include multiple flame markers within one paid action. The network route has a different accepted input schedule: 108 events comprise 34 shot markers, 54 sound markers and twenty pickup claims, with final energy `119, 119, 119, 118` and three lives per player. Each station resolves in player order `4, 3, 2, 1` in both routes.

One network client drops six event frames. Claims 600 and 601, committed at ticks 10 and 11, arrive at tick 21 and are actually drawn at display tick 24. All twenty unique claims render on each client. Duplicate replay is observed and deduplicated. The run keeps the existing six-command input ceiling, bounded event history and host-clock checks.

The complete mission regression compares all 9,072 noninitial world/visual boundaries and 85 rendered supply-count checkpoints using the existing native assets. It creates no new review movies and does not supersede the original W06 captures or their unanswered human review.

The whole-suite workerd conformance request now has a 60-second test-harness bound. Its previous 20-second bound timed out after adding the new archive-replay cases; the preceding published suite already used 18.2 seconds. The passing suite took 25.3 seconds in Node, 21.4 seconds in local workerd and 20.5 seconds in Chromium. This is separate from any single game tick or deployed CPU budget. The evidence retains that timeout and the corrected route/format/removal expectation failures. Runtime timing guards were not relaxed.

## Evidence and limits

The immutable [artifact manifest](pickup-integration-2026-09-08/artifacts.json) binds the tested source files, dependency bytes, compressed raw reports, recordings, screenshots, failure controls and six rebuilt bundles. The bundle set covers portable contracts, the SQLite test Worker, diagnostic room Worker, both browser laboratories and Breakwater. All six rebuilt bundles match the tested hashes. The package retains 386 repository source fingerprints, one dependency fingerprint and 66 artifacts totaling 8,134,460 bytes. Manifest SHA-256 is `381084dc22f5d6aff7e70ed687d91bbe42b6588bfd2148ce65957a4b3eb466dd`. [Portable pickup results](pickup-integration-2026-09-08/pickup-combat.json) and [mission results](pickup-integration-2026-09-08/mission-supplies.json) provide compact inspection entry points.

Wrangler source and generated deployment configuration enable traces and logs at sampling 1, invocation logs and source-map uploads. The setting follows [Cloudflare's tracing configuration](https://developers.cloudflare.com/workers/observability/traces/). Live deployed trace ingestion and room cadence remain unverified; local correctness and browser evidence cannot establish those results.

W07 remains open for its remaining weapon/material/mission introduction matrix and final media. W08 vehicle engineering, production v3, the full campaign and human acceptance remain separate unfinished work.
