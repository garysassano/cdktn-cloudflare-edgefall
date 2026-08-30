# Agent instructions

## Toolchain

Use mise for contributor tools and pnpm for package management. Keep pnpm 12 and TypeScript 7 unless an explicit compatibility requirement changes them.

Wrangler owns local development and bundling only. CDK Terrain and OpenTofu own deployed Cloudflare resources; keep matching Worker settings in `wrangler.jsonc` and `src/stacks/edgefall-stack.ts` synchronized.

## Game architecture

Keep the simulation in `src/game/` deterministic and platform-neutral. Browsers send input intent, while the Durable Object remains authoritative for movement, combat, upgrades, boss phases, and outcomes.

Do not add a normal-path dependency on downloaded game assets. Prefer the existing procedural canvas style for characters, enemies, effects, and animation.

## Validation

Run `pnpm check` after changes. Changes to the Worker binding shape must also pass `pnpm types` and keep `worker-configuration.d.ts` current.

Regenerate both architecture diagram themes with `python3 scripts/build-diagram.py` after changing the depicted service flow.

## Markdown

Never hard-wrap prose. Keep one paragraph or sentence per line and let the editor soft-wrap it.
