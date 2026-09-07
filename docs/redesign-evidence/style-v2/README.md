# W06 original art source review

The redesign's first hero concept studies and a local source-review page are implemented. Both studies require revision. This is the start of W06: native animation frames, separate locomotion/upper-body channels, root/socket metadata, enemies, tank, effects, scenery, audio and the playable 45–60-second benchmark are still required. Human style review remains pending.

## Inspect and reproduce

Run `pnpm dev:lab` and open `http://localhost:8787/art-review.html`. Select a study, compare black/white/gray/cyan/magenta backgrounds, inspect source pixels, and show the requested cell boundaries. The requested-logical-size option is explicitly a resampled concept preview; it neither writes nor approves a native atlas. The page loads original PNG bytes and links their exact prompts. An ordinary client build removes the page and source copies.

`pnpm art:validate` checks source/prompt hashes, provenance, bounded PNG decoding and the checked-in [source review](source-review.json). `pnpm art:review` regenerates that report after inspecting a deliberate source or policy change. `pnpm test:art:review` builds the explicit local review page and verifies it in Chromium. Set `EDGEFALL_CHROMIUM_PATH` when Chromium is provided outside Playwright's default installation.

The original lossless PNGs and prompts are in [art/source/hero](../../../art/source/hero), with the [source index](../../../art/source/provenance.json). They were generated with OpenAI's built-in image tool, without third-party reference images. The second operation used only the first project image as its edit target. The source files are retained unchanged, including failed output. No final gameplay frame is exported from them.

## Measured defects and craft review

| Study                                                                       | Decoded result                                                                                                                                                         | Required revision                                                                                                                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Original eight-pose study](../../../art/source/hero/key-pose-study-01.png) | 1774×887; 1,164,103 transparent pixels, 408,498 partial-alpha pixels and only 937 fully opaque pixels. The requested source was 1024×512 with a uniform 4× pixel grid. | Redraw at the intended native scale with clean binary body alpha, stable roots and clearly complementary run contacts. The generated run poses are too similar to establish a stride. |
| [Attempted run-pose edit](../../../art/source/hero/key-pose-study-02.png)   | 1774×887 RGB; all 1,573,538 pixels are opaque. The apparent checkerboard is painted into the source.                                                                   | Rejected as a sprite source. Retained to expose the failed transparency and changed sheet rather than silently repairing or shipping it.                                              |

The character study explores an exposed face, short orange field jacket, teal backpack, blue trousers and broad gloves/boots. These are proposed design choices, with human review pending. The fixed 384×216 gameplay viewport and proposed 34–40-pixel standing height remain the benchmark targets. Resizing an over-detailed montage in a browser does not establish one-source-pixel-per-logical-pixel art or temporal consistency.

The decoder inspects actual RGBA samples: transparency, opacity, partial alpha, hidden RGB and exact repeated blocks at the declared pixel scale. A PNG header declaring alpha is insufficient. Color-count reporting is capped and diagnostic; it is not a universal artistic palette limit. This is an import assessment, not a production exporter or an approval workflow. Source integrity may pass for a rejected concept, and machine pixel checks cannot grant human art acceptance. The decoder uses [sharp's documented pixel/metadata APIs](https://sharp.pixelplumbing.com/api-input/), with sharp 0.35.4 pinned as a development dependency after checking its current release and Node compatibility.

## Validation

`CHECKPOINT_DISABLE=1 pnpm check` passes 572 tests across 59 files, including seven art-import cases for exact grids, partial/opaque alpha, hidden colors, corrupt/oversized input, provenance drift and separation of pixel validity from human approval. Existing asset/content checks, all TypeScript targets, the client/Worker dry run and CDK Terrain synthesis pass. [Check log](check.log.gz).

Chromium 151.0.7922.34 verifies both studies, all five backgrounds, source dimensions, rejection messages, requested-size previews, grid controls and exact-prompt links, with no page exceptions. [Browser report](browser.json), [browser log](browser.log.gz), [first source against cyan](hero-study-cyan.png), [opaque edit at requested logical size](rejected-edit-logical.png). The screenshots were inspected. [Production-isolation proof](production-isolation.json) confirms that a normal build excludes the review page and source images, while the runtime asset manifest, Worker entry and Wrangler configuration remain unchanged. [Source/artifact identity](artifacts.json).

## Next production work

Create native root-aligned key drawings and a real phased run cycle, then separate legs and upper aim poses in the frame/timeline pipeline. Bind each exposure to the existing authoritative action/socket contracts and review native/scaled images plus frame-by-frame playback. Add the representative rifleman, shield enemy, tank and interaction effects, destructible, boss target, layered scenery and authored sounds to the same playable specimen. Capture normal/quarter-speed, clean/debug, audio comparison and four-player footage before requesting the full W06 human style review.

The [integrated combat/tank audit](../W05-acceptance-audit.md) supplies the engineering scenes. Production v3, the retained host-clock and impairment findings, deployed telemetry/timing, full W07/W08 behavior, authored campaign and later quality gates remain open.
