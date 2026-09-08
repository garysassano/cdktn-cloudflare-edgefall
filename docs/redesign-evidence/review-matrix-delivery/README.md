# W06 review delivery receipt

The [draft review download](https://github.com/garysassano/cdktn-cloudflare-edgefall/releases/tag/untagged-041ea219d6f27455e6aa) contains all 104 expected assets: 48 MP4 movies, 48 raw WebMs, six weapon sheets, `review.html` and `artifacts.json`. GitHub asset metadata and all downloaded bytes match their expected SHA-256 hashes and sizes, totaling 778,973,572 bytes. The draft targets source commit `edac319fdd69d075caf3e1bf877929ad984b9cd9` and remains a draft prerelease with no publication date. Access to the draft requires an authenticated repository maintainer.

The capture manifest is `5a5e2508a8b7a814a076d7d74f2b3d8dafc20c309c68f598210a725dd6063f38`. GitHub's contents API also reports the same manifest Git blob as the local source commit: `9cdf89bda244002925c23100631979f43ebf9f0e`, 221,176 bytes. The package's 936 source/artifact/manifest Git blobs and three historical reference manifests were verified before the source commit was pushed. The [remote receipt](remote-proof.json) retains each asset's identifier, URL, size and expected/downloaded digest.

## Open the review

The verified local copy is `dist/review-matrix-release/downloaded/review.html`. Keep all downloaded files in that directory and open the page directly in a browser. A fresh download can be made from this repository with the mapped GitHub CLI:

```sh
if [ -x "$HOME/.local/bin/gh" ]; then
  "$HOME/.local/bin/gh" release download w06-review-v2-kestrel --dir dist/review-download
else
  gh release download w06-review-v2-kestrel --dir dist/review-download
fi
```

Open `dist/review-download/review.html` after the download completes. Select players, playback speed, overlays, music and effects. The scene buttons pause before an event; press Play to inspect it. The current operative/tank sheets and source studies remain linked from the [review index](../style-v2/README.md).

## Verification

Chromium opened the downloaded viewer through a `file:` URL with no server. All 48 selections loaded the expected native 384×216 movies, all 27 scene jumps reached their expected positions, muted playback advanced and the weapon image loaded. No page error or network request occurred. The 400-pixel viewport had no document overflow. The [offline report](offline-report.json), [desktop capture](desktop.png) and [mobile capture](mobile.png) retain this check. Earlier local HTTP viewer checks passed the same 48 selections and 27 jumps.

The executed [verification script](verify-offline-viewer.mjs) can be rerun from the repository after downloading every asset. Set `EDGEFALL_CHROMIUM_PATH` when using an externally installed Chromium:

```sh
node docs/redesign-evidence/review-matrix-delivery/verify-offline-viewer.mjs dist/review-download dist/review-offline-check
```

The retained [project check](project-check.log) passed 694 tests across 69 files, plus asset, art, audio, content, type, bundle and infrastructure validation for the capture source. The [capture report](../W06-review-matrix.md) records replay, stereo, cue counts, resumption and source-comparison scope. This receipt's [artifact manifest](artifacts.json) fingerprints the verification files separately from the immutable capture package.

All eight human style/listening categories remain pending. Physical speakers/headphones, controller feel, sustained host/network timing, deployed trace ingestion, production v3 and the complete campaign remain separate open work. The draft and automated checks do not grant artistic acceptance.
