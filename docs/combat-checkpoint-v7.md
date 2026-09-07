# Diagnostic combat archive format 7

Historical format 7 contract. Current tank and seat continuation uses [format 8](combat-checkpoint-v8.md); format 7 archives are rejected.

This revision used archive **7**, protocol **3.6**, combat snapshot section **2**, and local simulation/recording format **4**. The [format 6 contract](combat-checkpoint-v6.md) describes the existing room, campaign, rifle, knife, grenade and shield continuation. This revision adds representative shotgun and flame attacks. Earlier experimental archives and client minors are rejected; production still uses v2.

## Private area state

`combat.areas` contains at most 16 attack groups, included in the existing combined 256-attack entity budget. A group stores its source ID, owner/team, global action ID, attack definition, start tick, consumed emission count, optional cancellation tick, active lobes and per-target hit receipts. Each lobe stores its authored emission index, root origin, cardinal heading and retained forward reach. A receipt contains a known enemy entity ID and next eligible damage tick; receipts are unique, sorted and bounded by the definition's target budget.

Capture validates source/action allocation and ownership, exact fields, finite lifetime, consumed emissions, lobe age/order, bounded coordinates/reach, cooldowns and cancellation. Attached flame must match its alive owner's current firing action and authored muzzle. A cancelled lobe must already have detached at the cancellation tick. Cancellation can precede or follow a same-tick emission because movement deaths occur before action evaluation and combat damage resolves after release. Future markers and still-attached lobes stop; detached flame and released shotgun blasts survive their owner.

The public snapshot carries exact clipped rectangles, identities, lifetime and attachment, with no private hit history. Restoring a checkpoint and its journal reconstructs the same rectangles and remaining damage eligibility. Content identity includes the authored profiles. Continue clears areas alongside other attacks while retaining the existing fresh-run allocation and input barriers.

## Representative content

Shotgun definition 10 spends one shell, has a 28-tick cadence and twelve-tick recoil action, and emits a six-tick volume expanding through 20/40/60/80/100/110 pixels. It deals four body damage once per entity per action, including actors with multiple hurtboxes. Frontal shields use the existing bullet material policy. The fixture starts each player with 24 shells.

Flame definition 11 spends one charge and emits lobes at offsets 0/6/12 during an eighteen-tick emission phase, with twelve recovery ticks before the next action. Each lobe lasts eighteen ticks, follows the current muzzle/heading for six, then travels with a frozen root/heading up to ninety pixels. All three lobes share one target ledger and six-tick damage cooldown. Earliest contact across lobes wins once per entity per tick. Heat spends one shield integrity without spilling into body HP; exposed infantry remains fragile. The fixture starts each player with thirty charges.

Centerline walls cap a lobe's forward propagation; floors and ceilings clip its cross-section. Contacted forward reach remains capped after a wall is removed. Partial side obstructions conservatively trim the rectangle's whole cross-section rather than creating multiple pieces. Moving victims are swept against the current authored exposure; newly emitted or redirected lobes use the tick endpoint. Terrain and shields occlude the contact point, and a detached lobe cannot damage an out-of-volume shield merely because it blocks a root ray. The broader moving-platform and authored obstacle matrix remains W07 work.

## Verification

Run `CHECKPOINT_DISABLE=1 pnpm check`, `pnpm test:contracts`, `pnpm test:storage:combat`, `pnpm test:lab:combat`, and the independent `pnpm test:network:controller --combat-shotgun` and `--combat-flame` modes. The local-only `PROBE_COMBAT_SCENARIO` binding accepts these two scenarios alongside `range`, `rifle` and `guard`; production bindings are unchanged.

The portable proof uses four ordinary input streams, including duplicated packets, over 120 ticks per scenario. Fifteen checkpoint/journal boundaries cover emission, attachment, shield break, body damage and expiry. SQLite verification adds final cold boundaries and injects a transaction rollback before every segment commit. Browser and local inspector evidence are recorded separately in [W05 area weapons](redesign-evidence/W05-area-weapons.md). These are engineering fixtures; tank interaction, final media, authored campaign missions, production v3 and live timing acceptance remain open.
