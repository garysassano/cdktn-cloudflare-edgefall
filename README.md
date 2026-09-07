# Edgefall

Edgefall is a one-to-four-player online run-and-gun roguelite vertical slice set in the diesel-fantasy Cinder Railworks.

Private crews cross hand-authored foundry modules, fight on a moving freight lift, survive the collapsing Fall, and break the three-phase Kilnheart Engine in an authoritative 30 Hz room.

Daily crews receive separate private rooms with the same fixed date seed, so their runs remain comparable without sharing live combat state.

## Architecture Diagram

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./src/assets/arch-diagram-dark.svg">
  <img alt="Architecture Diagram" src="./src/assets/arch-diagram.svg">
</picture>

The deterministic TypeScript simulation in `src/game/` is shared by the browser and Durable Object.

Phaser is presentation-only: it renders at a 640×360 logical resolution, predicts the local player's movement, reconciles acknowledged inputs, and interpolates remote snapshots.

The Worker serves static assets and profile, leaderboard, result, and room routes; one hibernatable Durable Object owns each active room; D1 stores anonymous profiles and run records; R2 stores compact completed-run replay streams.

CDKTN owns the D1 and R2 backing resources.

Wrangler exclusively owns Worker code, the Durable Object migration, bindings, and static-asset deployment.

## Prerequisites

- Cloudflare API access with `Workers Scripts:Edit`, `D1:Edit`, `Workers R2 Storage:Edit`, and `Account Settings:Read` permissions.
- [mise](https://mise.jdx.dev/installing-mise.html), which installs the repository's Node, pnpm, OpenTofu, and CDKTN versions.

## Installation

```sh
mise install
pnpm install
pnpm gen
cp .dev.vars.example .dev.vars
```

Set a local `PROFILE_COOKIE_SECRET` of at least 32 random characters in `.dev.vars`.

`pnpm gen` generates the Cloudflare provider constructs into `.gen/`; rerun it when the provider constraint in `cdktf.json` changes.

## Local play

```sh
pnpm dev
```

Open `http://localhost:8787`.

Wrangler supplies local Durable Object, D1, R2, and static-asset implementations, so local play does not require a Cloudflare account.

### Controls

- Run: `A` / `D` or left stick.
- Jump: `Space` or gamepad south; hold `S` and jump to drop through a platform.
- Aim and fire: pointer and primary mouse button, or right stick and right trigger.
- Reload: `R` or right bumper.
- Dodge: `Shift` or gamepad east.
- Melee and revive: `F` or gamepad west.
- Ordnance: `Q` or left bumper.
- Operative ability: `E` or gamepad north.

Friendly fire is disabled, upgrade choices are personal, and destructible supplies are shared automatically.

Downed operatives can crawl and use a sidearm, allies revive with melee, and an eliminated operative re-enters after a short delay.

### Redesign controller laboratory

Run `pnpm dev:lab` and open `http://localhost:8787/controller-lab.html` for the new 60 Hz controller's isolated engineering surface. Select the obstacle course, moving support, crush, grounded enemy ledge authored jump/drop link or chained-route fixture; run or single-step, inspect contacts, and export/import a bounded deterministic input recording. This lab uses temporary geometry visuals and does not connect to a multiplayer room. The ordinary client build excludes development laboratories.

`pnpm test:lab:controller` builds the labs and verifies keyboard input, replay and rendering in local Chromium. Set `EDGEFALL_CHROMIUM_PATH` to an installed Chromium executable when it is not in Playwright's default location. See the [controller lab evidence](./docs/redesign-evidence/W03-controller-lab.md) for exact coverage and remaining acceptance work.

Open `http://localhost:8787/combat-lab.html` for the shared firearm timeline, authored muzzle/hurtbox inspector and swept projectile path. The range, thin-wall and frontal-shield scenarios support one to four deterministic input slots, sidearm/HMG cadence and ammo, physical target motion, exact kill credit, single stepping and recording replay. `pnpm test:lab:combat` verifies its browser controls and replay. These are engineering fixtures; production combat and final media remain in progress.

`pnpm test:network:controller --combat` owns a local workerd room and four Chromium contexts to verify authoritative firearm/projectile snapshots, enemy removal and shared world hashes. `--combat-fault` instead rejects a prepared world tick and verifies that no world state, committed event or input acknowledgment advances. The regular command and `--recovery` retain the movement/lease and controller-session checks. See the earlier [world transaction evidence](./docs/redesign-evidence/W04-world-transaction.md) for the commit boundary and initial snapshot proof.

`pnpm test:network:controller --events` verifies the [acknowledged gameplay-event stream](./docs/events-v3.md), including dropped-frame replay, duplicate suppression, ring expiry and explicit full-baseline repair for individual readers. See the [event delivery evidence](./docs/redesign-evidence/W04-events.md). Confirmed engineering hit/shot markers use event identities; predicted effects, final audio and complete combat recovery remain in progress.

`pnpm test:network:controller --combat-reconnect` verifies signed profile ownership, individual socket takeover/reentry, fresh snapshot acknowledgment, healthy player continuity and SQLite recovery after reconnection. The loopback laboratory preserves the reserved player's weapon, active action and lives; its browser initializes the renderer before requesting a moving-world baseline. `--combat-recovery` retains the separate full-cohort process/write-failure recovery proof. See the [per-player reconnect evidence](./docs/redesign-evidence/W04-combat-reconnect.md) for scope and remaining production work.

`pnpm test:network:controller --combat-auto-reconnect` verifies automatic recovery in the same browser documents after a peer disconnect, a browser stall and a Worker process restart. It also checks profile loss and tab takeover; an empty cohort remains paused until explicit authority recovery and the fresh-input start barrier. The production v2 client shares the bounded reconnect transport and no longer converts an expired resume into a new join. See the [automatic reconnect evidence](./docs/redesign-evidence/W04-automatic-reconnect.md), including production browser coverage and preserved host-clock failures.

## Production deployment

Deploy the backing resources and Worker:

```sh
pnpm run deploy
```

Immediately after the first deploy, add the Worker secret with the generated production configuration:

```sh
pnpm exec wrangler secret put PROFILE_COOKIE_SECRET --config .wrangler.deploy.json
```

Later deploys preserve the secret.

The deploy command builds and validates the client, provisions D1 and R2 with CDKTN, writes their outputs to the ignored Wrangler configuration, applies D1 migrations, and deploys Worker code, the Durable Object migration, and static assets with Wrangler.

The [vertical-slice migration note](./docs/migration-notes.md) records the intentional pre-1.0 reset of incompatible prototype leaderboard rows.

Destroying the CDKTN stack removes only its backing resources:

```sh
pnpm destroy
```

Remove the Wrangler-owned Worker separately when a complete teardown is intended.

## Content and evidence

The current slice contains Rook and Vale with two outfits, four primary weapons, two ordnance choices, weapon mutations, relics, five standard enemy roles, the Slag Warden elite, destructibles, the freight-lift fight, the Fall, and the Kilnheart Engine.

The [style benchmark](./docs/style-benchmark.md) records the art, animation, VFX, control, and audio approval gate.

Its Rook, enemy, weapon, VFX, and environment assets are integrated, while palette variants stand in for the remaining final production art until that benchmark is approved.

Every runtime media file is original or redistribution-compatible licensed and recorded in the checked-in [asset provenance manifest](./public/assets/manifest.json).

The 12–18 minute duration, stable 60 FPS target, boss readability, and four-player enjoyment remain playtest acceptance criteria; automated checks do not claim those human and hardware results.

## Validation

```sh
pnpm check
pnpm types
```

`pnpm check` runs Biome, asset integrity and licence validation, all three TypeScript configurations, the deterministic simulation and network tests, the Worker/client dry-run bundle, and CDKTN synthesis.

`pnpm types` refreshes `worker-configuration.d.ts` after a binding change.
