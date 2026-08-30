# Agent instructions

## Toolchain

Use mise for contributor tools and pnpm for package management. Keep pnpm 12 and TypeScript 7 unless an explicit compatibility requirement changes them.

Wrangler exclusively owns Worker code, Durable Object migrations, static assets, and their deployment. CDK Terrain and OpenTofu own backing Cloudflare resources such as D1 and R2; pass their synthesized identifiers into Wrangler's deploy configuration.

## Game architecture

Keep the simulation in `src/game/` deterministic and platform-neutral. Browsers send input intent, while the Durable Object remains authoritative for movement, combat, upgrades, boss phases, and outcomes.

Runtime art, music, and sound must be original or redistribution-compatible licensed assets checked into `public/assets` and recorded in `public/assets/manifest.json`. Run the asset validator after every change, keep the style benchmark review gate ahead of remaining final asset production, and do not use procedural Canvas figures or oscillator audio as final assets.

## Validation

Run `pnpm check` after changes. Changes to the Worker binding shape must also pass `pnpm types` and keep `worker-configuration.d.ts` current.

Regenerate both architecture diagram themes with `python3 scripts/build-diagram.py` after changing the depicted service flow.

## Markdown

Never hard-wrap prose. Keep one paragraph or sentence per line and let the editor soft-wrap it.
