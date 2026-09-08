# Edgefall original benchmark review

The current published art is the [Kestrel suspension/recoil increment](../W06-kestrel-motion.md), following the [operative airborne/landing](../W06-operative-air.md), [aim/recoil](../W06-operative-aim.md), [crew transfers and forced ejection](../W06-crew-transfers.md), and [recorded interaction audio](../W06-interaction-audio.md) increments. These are original benchmark candidates with pending human review. The continuous mission is [Breakwater Approach](../W06-breakwater.md); production v3 and the complete campaign are separate open work.

The [complete current review matrix](../W06-review-matrix.md) passes all 48 movies across solo/two/four players, normal/quarter playback, clean/debug views, music on/off and full/reduced effects. Its [artifact manifest](mission-review/artifacts.json) retains 399 repository artifacts, 536 source fingerprints, all 288 selected stills, input recordings and clock/stereo reports. The MP4/raw WebM set, offline viewer and six weapon sheets are prepared for a GitHub draft; remote delivery verification remains pending. Historical movie files retain their original art and hashes.

## Current inventory and source

| Family | Original drawings | Atlas entries | Editable source |
| --- | ---: | ---: | --- |
| Operative | 149 | 596 | [Hero source](../../../art/source/hero/operative.pixels.json) |
| Quay Watch rifle enemy | 19 | 19 | [Rifle source](../../../art/source/enemies/quay-watch.pixels.json) |
| Breakwater shield enemy | 27 | 27 | [Shield source](../../../art/source/enemies/breakwater.pixels.json) |
| Kestrel tank and crew | 72 | 288 | [Vehicle source](../../../art/source/vehicles/kestrel.pixels.json) |
| Quay scenery and lock engine | 25 | 25 | [Scenery sources](../../../art/source/environment) |
| Combat effects | 112 | 112 | [Effects source](../../../art/source/effects/breakwater-fx.pixels.json) |
| Total | 404 | 1,067 | [Provenance](../../../art/source/provenance.json) |

Each runtime frame comes from literal palette-indexed pixels. The operative has four jacket identities, 51 clips and a fixed feet root `(24, 48)` in an untrimmed 64×64 canvas. Kestrel has separate tracks, hull, world turret and crew layers with an accepted body root `(48, 72)` in a 96×96 canvas. Its four crew identities use the same operative palette convention. All seven native textures total 34,169,600 decoded RGBA bytes, within the existing 64 MiB benchmark limit and independent 2048-pixel texture-dimension limit; that count does not measure GPU allocation overhead.

The recorded sound set has 52 cue/loop variants, including two persistent loops, with editable sessions, retained CC0 foley, licensed instrument sources and lossless derived masters. The two music arrangements have editable scores and lossless masters. The combined decoded encounter audio occupies 24,242,240 bytes, below the existing 32 MiB limit. See [audio provenance](../../../audio/source) and the [interaction audio report](../W06-interaction-audio.md). Source licenses and original recordings remain in the repository; no SNK runtime media is used.

## Review the candidates

Start `pnpm dev:lab`, then open `/benchmark.html` to play the mission or import a retained recording. `/art-review.html#native` provides native/integer scale, individual frame/clip, palette, background and mirrored operative inspection. `/combat-lab.html?cast=1` exposes accepted combat, enemy and vehicle state. Ordinary builds exclude these diagnostic pages; they do not select these candidates in the v2 product.

The most recent composed sheets cover [operative air](operative-air/sheets/air-white-1x.png), [landing](operative-air/sheets/impact-white-4x.png), [operative palettes](operative-air/sheets/palettes-black-4x.png), [tank treads](kestrel-motion/sheets/drive-white-1x.png), [tank airborne acting](kestrel-motion/sheets/air-white-4x.png), [tank impact](kestrel-motion/sheets/impact-white-4x.png) and [all eight turret headings and recoil](kestrel-motion/sheets/aim-white-4x.png). Corresponding black/white/chroma and native/4× sheets accompany them. Each linked increment includes its own source and artifact manifest.

The current operative short movies cover all four firearms in both directions through accepted jumps and impacts. Current cast movies cover rifle/shield behavior, boarding/ordinary exit, tank movement/jumps/aim/fire and a destruction-driven ejection. Current solo/two/four mission movies, input recordings and stills preserve all recorded world/effects hashes from the preceding increment. The [weapon comparison](mission-review/weapons/weapons-black-4x.png) isolates sidearm, HMG, shotgun, grenade and flamethrower actions at release and two/four/six ticks later, using actual source pixels at 20 accepted states. These checks establish source fidelity and deterministic replay; they do not grant artistic, listening or stable-host timing acceptance.

## Acceptance remains pending

A human reviewer must assess silhouette/readability, pixel discipline, motion/acting, weapon distinction, vehicle weight, environment separation, multiplayer clarity and audio impact individually. Every category is currently `pending`; no named reviewer or acceptance is recorded. The complete current movie matrix and weapons comparison are ready locally; verify their remote delivery before requesting the overall W06 review. Remaining final art/audio production follows that acceptance gate; independent simulation, networking and platform engineering can continue.

Captures currently use Chromium with physical audio output disabled, while WebAudio and MediaRecorder remain active. Recorded headroom and clock checks do not establish physical-device performance or human listening quality. Production networking, deployed room cadence and live trace ingestion remain open. Traces, invocation logs, full sampling and source maps are configured, with no live-ingestion claim.

## Historical evidence

The folders `mission`, `mission-effects`, `mission-audio`, `mission-crew`, `operative-aim`, `operative-air`, `kestrel-motion`, `cast` and `native-actions` preserve their published bytes. Later reports identify which source revision and limitations apply; do not infer current counts or artwork from an older movie or sheet.

The early [source studies](source-review.json), [import assessment](artifacts.json) and [concept browser report](browser.json) document the rejected illustration/transparency experiments and the original import tooling. They are historical foundation evidence. The [historical native action index](https://github.com/garysassano/cdktn-cloudflare-edgefall/blob/200be35c1a098df9240ee6968059190be580f864/docs/redesign-evidence/style-v2/README.md#validation-of-the-native-action-revision), [cast report](../W06-native-cast.md), [protected entry report](../W03-player-entry.md) and [combat/tank audit](../W05-acceptance-audit.md) retain their original implementation scope. Original action sockets, exact source exports and historical hashes remain reviewable alongside the current increments.
