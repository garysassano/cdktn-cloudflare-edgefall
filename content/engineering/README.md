# Compiled navigation engineering fixture

`navigation.ldtk` is a synthetic, schema-complete LDtk 1.5.3 fixture authored for the content compiler. It has not yet been opened and saved in the graphical editor; editor round-trip acceptance remains required before mission authoring. `terrain.png` is an original 10×10 solid-color engineering tile made for this fixture, covered by the repository MIT license. It is neither final game art nor part of the production asset manifest; ordinary client builds exclude it. The controller laboratory loads it only in the opt-in lab build.

Run `pnpm content:compile` after editing this fixture. The generated `src/game/content/compiled/navigation.json` is checked in. `pnpm content:validate`, included in `pnpm check`, recompiles and rejects stale output. The current command deliberately uses the engineering actor/action library; production mission library selection is still pending.

Select `compiled-route` in `pnpm dev:lab` and queue the authored route. The lab uses the generated collision/route data and tile manifest. It does not parse raw editor data. Two jumps and walking/settling approaches reach the checkpoint in 117 ticks.

The supported authoring profile is one embedded level at world origin, at most 4,096 pixels per dimension and 16,384 grid cells, with exactly these layers:

| Layer     | Type     | Contract                                                                                                                                                                   |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collision | IntGrid  | 0 empty, 1 solid, 2 one-way. Every occupied cell needs an opaque tile in Gameplay. Equal horizontal solid runs merge across adjacent rows; one-way planes remain separate. |
| Gameplay  | Tiles    | Same grid as Collision, opaque and visible, zero offsets/parallax, a contained PNG tileset with no padding or spacing. Tile flips are supported.                           |
| Logic     | Entities | Stable integer handles and explicit feet/root or region coordinates, with pivot (0, 0). At most 512 entities and 256 links.                                                |

All entities carry `StableId` in 1,000,000–16,777,216, unique across the level. Terrain IDs use 1 plus the anchor cell index, independently of entity handles and array order. Authoring a changed terrain partition may change its anchor and requires a new content/geometry identity.

| Entity      | Additional Int fields                                    | Purpose                                                                                                              |
| ----------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Entry       | ActorId                                                  | Exactly one grounded player start.                                                                                   |
| Checkpoint  | None                                                     | Exactly one supported destination touching the Exit region.                                                          |
| Spawn       | ActorId                                                  | Grounded spawn with full-foot support, body clearance and kill-bound containment.                                    |
| Jump / Drop | ActorId, DestinationX, DestinationY, Direction, MaxTicks | Source at the entity root, exact destination in logical pixels, direction −1 or 1, and at most 180 controller ticks. |
| Camera      | None                                                     | Exactly one region, using entity width and height.                                                                   |
| KillBounds  | None                                                     | Exactly one region containing the camera. Checkpoint traversal must keep the body inside it.                         |
| Exit        | None                                                     | Exactly one region inside the camera and unobstructed by solids.                                                     |

The compiler validates the official schema, definition/instance references, supported authoring fields, collision visibility, spawn clearance, link trajectories and actual checkpoint execution. Unsupported worlds, external levels, entity roles, auto layers, offsets and parallax fail explicitly. It does not silently approximate slopes, hazards, flying corridors, vehicle routes, moving platforms or campaign triggers; these still need schema and runtime support.

The output separates canonical gameplay content from tile presentation. Tile changes alter the graphics identity; PNG bytes are included in that identity. The combined build hash contains the compiler contract version, content hash and graphics hash. Full audio/media identity, protocol negotiation, production compiler versioning/migrations, checkpoint graph coverage across encounters and real editor round-trip proof remain open. PNG validation currently checks the signature and declared dimensions; it is not a general image decoder or final-media validator.
