# Edgefall style benchmark

This document records the legacy v2 product's asset prompts and original benchmark. The arcade redesign uses the [W06 source review and replacement benchmark](redesign-evidence/style-v2/README.md). A native operative candidate now renders separate legs and sidearm aim drawings in the local combat inspector; silhouette and motion revisions, the remaining representative media and human style approval are still required.

Status: **review required before producing the remaining final art and audio**.

This benchmark establishes the Cinder Railworks quality bar with one finished Rook presentation set, four modular weapon layers, one furnace trooper, a combat VFX set, one layered environment plate, distinctive weapon feedback, and adaptive biome and boss audio.

The playable build uses palette variants for Vale and the additional enemy roles so the whole vertical slice can be tested without treating those variants as approved final assets.

## Representative 20-second combat beat

| Time    | Beat                                                                                  | Quality check                                                                                   |
| ------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0–4 s   | Rook runs in, jumps to the catwalk, and fires the carbine.                            | Crisp silhouette, readable aim layer, carbine flash and light recoil.                           |
| 4–8 s   | A rusher closes while a rifleman fires from range; Rook dodges through the crossfire. | Hostile fire reads red, dodge reads violet, no whole-body aim rotation.                         |
| 8–12 s  | Rook crouches, breaks a barrel with melee, and swaps pressure to the scattergun.      | Crouch aim remains clear, debris separates from impact VFX, scattergun is unmistakably heavier. |
| 12–16 s | A shieldbearer blocks the lane; a rivet detonates behind it.                          | Rivet cadence, projectile, impact, shake, and sound form one recognisable signature.            |
| 16–20 s | Rook revives a downed Vale as the Kilnheart telegraph floods the lower platform.      | Revive state remains legible under effects and the boss warning leaves an avoidable route.      |

## Approval checklist

- Character proportions and diesel-fantasy tone are original, coherent, and readable at 640×360.
- Every required animation state reads without relying on the HUD.
- Separate body, upper-body, and weapon layers preserve left/right facing while supporting full aim direction.
- Carbine, scattergun, rivet launcher, and beam can be identified from animation, VFX, recoil, projectile, impact, and sound.
- Amber biome light, violet fractures, and red hostile telegraphs remain distinct under the high-contrast and reduced-flash settings.
- The environment supports foreground combat readability while retaining useful parallax depth.
- Audio is acceptable as a benchmark source set or is replaced with similarly licensed authored layers before final production.

## Provenance and policy

The machine-checked provenance record is [`public/assets/manifest.json`](../public/assets/manifest.json).

The environment plate and sprite benchmark are original AI-assisted project assets produced with OpenAI's built-in image generation without third-party reference images.

The current audio benchmark is a curated CC0 set from Kenney Digital Audio, Impact Sounds, and Music Jingles.

No runtime art or audio may be added without an entry in the provenance manifest, a redistribution-compatible licence or original-project declaration, an integrity hash, and a size budget.

## Final image prompts

### Cinder Railworks environment

```text
Use case: stylized-concept
Asset type: game environment background plate for a crisp 2D side-scrolling browser game at 640x360 logical resolution
Primary request: an original diesel-fantasy Cinder Railworks foundry section for Edgefall, with an elevated steel gantry, massive furnace machinery, freight lift rails, hanging chains, molten metal channels, and a violet dimensional fracture in the far background
Scene/backdrop: layered industrial foundry with clear foreground platform silhouette, midground machinery, and distant smokestacks; no characters
Style/medium: polished hand-painted pixel art, 32-bit era arcade detail, crisp hard-edged pixels, original visual language, not derivative of any named game
Composition/framing: exact 16:9 landscape side view, gameplay-readable, walkable foreground across the lower third, open combat space in the middle, strong depth layers, no perspective tilt
Lighting/mood: hot amber furnace light against soot-black steel and restrained violet rift glow; kinetic diesel-fantasy pulp
Color palette: charcoal, gunmetal, oxidized brass, ember orange, molten yellow-white, sparse violet
Materials/textures: riveted steel, worn warning paint, brick, smoke, slag, heat shimmer
Constraints: no text, no logos, no watermark, no UI, no characters, no recognizable copyrighted designs; nearest-neighbour-friendly pixel clusters; no antialiased vector look
Avoid: top-down view, photorealism, 3D render, smooth gradients, modern clean factory, steampunk top hats or Victorian ornament, complete black foreground silhouettes
```

### Rook sprite benchmark

```text
Use case: stylized-concept
Asset type: transparent game sprite benchmark sheet for a crisp 2D side-scrolling browser game
Primary request: an original diesel-fantasy pixel-art production sheet showing one finished operative named Rook, his modular carbine, one riveted furnace trooper enemy, and a compact set of orange-and-violet combat VFX
Subject: Rook is a broad defensive bruiser in a soot-dark work coat, armored shoulder plates, reinforced boots, half-mask and amber visor; the carbine is a compact industrial firearm with a brass heat shroud; the enemy is a hunched masked foundry conscript with a riveted shield; VFX include muzzle flash, tracer, bullet impact, sparks, smoke puff, shell casing, violet dodge afterimage
Style/medium: polished hand-authored pixel art sprite sheet, clear arcade silhouettes, hard 1-pixel clusters, limited diesel-fantasy palette, consistent side-on orthographic view, original design
Composition/framing: transparent canvas arranged as a clean regular grid with generous transparent gutters; full-body Rook frames all facing right in rows for idle, run, jump, crouch, dodge, fire, reload, hurt, downed and revive; separate carbine and upper-body aiming pieces; enemy idle and attack frames; VFX isolated in equal cells
Lighting/mood: hot amber rim light, cool violet accents, soot-black shadows
Color palette: charcoal, dark olive, oxidized brass, ember orange, ivory highlights, restrained violet
Constraints: genuinely transparent background; no grid lines, labels, text, logos, watermark, scenery or floor shadows; every sprite fully contained and separated; consistent character scale and anatomy; no rotated whole character bodies; nearest-neighbour-friendly; no recognizable copyrighted character or weapon designs
Avoid: concept-art montage, smooth painting, 3D render, antialiasing, white background, overlapping sprites, cropped limbs, inconsistent scale, tiny unreadable figures
```

### Transparency correction

```text
Use case: background-extraction
Asset type: transparent game sprite benchmark sheet
Input images: Image 1 is the edit target
Primary request: remove only the brown and violet background field and replace it with genuine full transparency
Constraints: change only the background; preserve every Rook pose, weapon, furnace trooper, muzzle flash, projectile, casing, spark, smoke and violet VFX exactly in its current position, scale, color and pixel-art style; retain soft effect alpha where it belongs; keep clear transparent gutters between sprites; no added grid, text, scenery, floor, shadow, logo or watermark
Avoid: recoloring, rearranging, redrawing, cropping, merging sprites, opaque checkerboards, white or solid-color background
```
