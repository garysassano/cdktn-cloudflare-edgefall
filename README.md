# cdktn-cloudflare-edgefall

CDKTN app for a cooperative browser hack-and-slash backed by an authoritative Cloudflare Durable Object.

## Architecture Diagram

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./src/assets/arch-diagram-dark.svg">
  <img alt="Architecture Diagram" src="./src/assets/arch-diagram.svg">
</picture>

## Prerequisites

- **_Cloudflare:_**
  - Must have set the `CLOUDFLARE_API_TOKEN` variable in your local environment, with the `Workers Scripts:Edit`, `D1:Edit`, `Workers R2 Storage:Edit` and `Account Settings:Read` permissions.
- **_mise:_**
  - [Install mise](https://mise.jdx.dev/installing-mise.html), which manages Node, pnpm, and OpenTofu.

## Installation

```sh
mise install
pnpm install
pnpm gen
```

`pnpm gen` generates the Cloudflare provider constructs into `.gen/`. Re-run it whenever the provider constraint in `cdktf.json` changes.

## Deployment

```sh
pnpm run deploy
```

## Usage

For local play:

```sh
pnpm dev
```

Open `http://localhost:8787`. A Cloudflare account is not required because Wrangler provides local Durable Object, D1, and R2 implementations.

- Move with `WASD` or the arrow keys.
- Aim with the pointer and hold the primary mouse button to slash.
- Press `Space` to dash with a brief invulnerability window.
- Share the room code to play with up to three other people.

## Cleanup

```sh
pnpm destroy
```

## How it works

The Worker serves the application, routes room WebSockets, exposes the health check, and returns the leaderboard. Each room has a hibernatable Durable Object that runs the authoritative simulation and persists the current game. D1 stores completed-run metadata for the leaderboard, while R2 stores compact replay summaries.

Wrangler owns the Worker **bundle**, CDKTN owns the **deployment**:

1. `pnpm bundle` builds the browser client, validates the Worker with a Wrangler dry run, and creates a self-contained `dist/index.js` with every static module embedded.
2. `src/stacks/edgefall-stack.ts` uploads that single module through `cloudflare_workers_script` and provisions its Durable Object migration, D1 database, R2 bucket, bindings, observability, and `workers.dev` subdomain.

`pnpm synth`, `pnpm diff`, `pnpm run deploy`, and `pnpm test` all run the bundle step first, so the synthesized stack always matches the current source.

Keep the compatibility date, compatibility flags, bindings, and migration in `wrangler.jsonc` synchronized with `src/stacks/edgefall-stack.ts`. Wrangler needs them to bundle and run locally, while OpenTofu needs them to deploy.
