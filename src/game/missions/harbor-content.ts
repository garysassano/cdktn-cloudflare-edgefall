import { HARBOR_GRENADIER } from "../actors/grenadier.js";
import type { DestructibleDefinition } from "../combat/destructible.js";
import type { WeaponPickupDefinition } from "../combat/pickups.js";
import type { MaterialSurface } from "../content/materials.js";
import { integer, pixels } from "../core/numeric.js";
import type { CombatStage } from "../labs/combat.js";
import { TANK_PROFILE } from "../labs/combat-content.js";
import { footTerrain } from "../labs/foot-fixture.js";
import { createTank } from "../vehicles/tank.js";

/** Physical Harbor route. Encounter rosters and the siege engine are separate authoring work. */
export const HARBOR = {
  id: "harbor-breach",
  width: 12288,
  fallBoundary: 448,
  maxTicks: 20 * 60 * 60,
  loadout: { weapon: "sidearm", ammo: 0, grenades: 6 },
  beats: [
    { id: "apron", start: 0, end: 1536 },
    { id: "docks", start: 1536, end: 3072 },
    { id: "rooftops", start: 3072, end: 4096 },
    { id: "rescue", start: 4096, end: 4608 },
    { id: "warehouse", start: 4608, end: 6144 },
    { id: "shield-yard", start: 6144, end: 7680 },
    { id: "tank-depot", start: 7680, end: 8192 },
    { id: "bridge", start: 8192, end: 10240 },
    { id: "rocket-cache", start: 10240, end: 10752 },
    { id: "siege-arena", start: 10752, end: 12288 },
  ],
  checkpoints: [
    { x: 48, y: 200, supportId: 1000 },
    { x: 1584, y: 200, supportId: 1000 },
    { x: 4656, y: 200, supportId: 1003 },
    { x: 7712, y: 264, supportId: 1007 },
    { x: 10304, y: 216, supportId: 1011 },
    { x: 10816, y: 200, supportId: 1012 },
  ],
  depot: { firstId: 600, firstX: 7784, spacing: 56, y: 264, supportId: 1007 },
  grenadier: HARBOR_GRENADIER,
  infantry: [
    { id: 20, kind: "rifle", x: 1824, y: 200, supportId: 1000, activateX: 1568 },
    { id: 21, kind: "rifle", x: 2368, y: 184, supportId: 1001, activateX: 2112 },
    { id: 22, kind: "grenadier", x: 3360, y: 128, supportId: 1021, activateX: 3104 },
    { id: 23, kind: "rifle", x: 3808, y: 168, supportId: 1002, activateX: 3552 },
    { id: 24, kind: "rifle", x: 5056, y: 200, supportId: 1003, activateX: 4800 },
    { id: 25, kind: "shield", x: 5536, y: 200, supportId: 1003, activateX: 5280 },
    { id: 26, kind: "shield", x: 6384, y: 200, supportId: 1004, activateX: 6128 },
    { id: 27, kind: "grenadier", x: 6864, y: 200, supportId: 1004, activateX: 6608 },
    { id: 28, kind: "rifle", x: 7088, y: 200, supportId: 1004, activateX: 6832 },
  ],
  supplies: [
    { id: 300, weapon: "heavy-machine-gun", ammo: 150, x: 4240, y: 200, supportId: 1003 },
    { id: 301, weapon: "shotgun", ammo: 24, x: 4752, y: 200, supportId: 1003 },
    { id: 302, weapon: "rocket-launcher", ammo: 12, x: 10400, y: 216, supportId: 1011 },
  ],
} as const;

export const HARBOR_PROPS: readonly DestructibleDefinition[] = [
  {
    id: 200,
    definitionId: 2,
    rect: { x: pixels(1712), y: pixels(168), w: pixels(32), h: pixels(32) },
    health: 6,
    materialId: "timber",
  },
  {
    id: 201,
    definitionId: 2,
    rect: { x: pixels(2640), y: pixels(152), w: pixels(32), h: pixels(32) },
    health: 6,
    materialId: "timber",
  },
];

export function harborPickups(players: number): WeaponPickupDefinition[] {
  integer(players, 1, 4, "Harbor supply party size");
  return HARBOR.supplies.flatMap((source) =>
    Array.from({ length: players }, (_, index) => ({
      id: source.id * 4 + index,
      claimId: source.id * 4 + index,
      sourceId: source.id,
      kind: "weapon" as const,
      weaponId: source.weapon,
      ammo: source.ammo,
      ammoLimit: source.ammo,
      activationTick: 1,
      expiresTick: HARBOR.maxTicks,
      supportId: source.supportId,
      rect: { x: pixels(source.x - 12), y: pixels(source.y - 23), w: pixels(24), h: pixels(23) },
    })),
  );
}

/** Contiguous walkable ground, including a lower depot and a stepped return from the bridge. */
export const HARBOR_TERRAIN: readonly MaterialSurface[] = [
  footTerrain(1000, 0, 200, 2048, 248),
  footTerrain(1001, 2048, 184, 1024, 264),
  footTerrain(1002, 3072, 168, 1024, 280),
  footTerrain(1003, 4096, 200, 1536, 248),
  footTerrain(1004, 5632, 200, 1536, 248),
  footTerrain(1005, 7168, 216, 256, 232),
  footTerrain(1006, 7424, 232, 256, 216),
  footTerrain(1007, 7680, 264, 512, 184),
  footTerrain(1008, 8192, 264, 1024, 184),
  footTerrain(1009, 9216, 248, 512, 200),
  footTerrain(1010, 9728, 232, 512, 216),
  footTerrain(1011, 10240, 216, 512, 232),
  footTerrain(1012, 10752, 200, 1536, 248),
  footTerrain(1013, -16, -64, 16, 512),
  footTerrain(1014, HARBOR.width, -64, 16, 512),
  footTerrain(1020, 512, 160, 160, 8, "one-way"),
  footTerrain(1021, 3264, 128, 160, 8, "one-way"),
  footTerrain(1022, 4768, 120, 512, 16),
  footTerrain(1023, 8384, 248, 128, 16),
  footTerrain(1024, 8960, 240, 128, 24),
];

/** Shared, individually claimable hulls; no slot reservation and no infinite replacement supply. */
export function harborDepot(players: number) {
  integer(players, 1, 4, "Harbor depot party size");
  return Array.from({ length: players }, (_, slot) =>
    createTank(
      HARBOR.depot.firstId + slot,
      { x: pixels(HARBOR.depot.firstX + slot * HARBOR.depot.spacing), y: pixels(HARBOR.depot.y) },
      HARBOR.depot.supportId,
      { ...TANK_PROFILE, fallBoundary: pixels(HARBOR.fallBoundary) },
    ),
  );
}

/** Mission owners add their active roster, live props and external boss hurtboxes to this geometry. */
export function harborStage(checkpoint: number): CombatStage {
  integer(checkpoint, 0, HARBOR.checkpoints.length - 1, "Harbor checkpoint");
  const entry = HARBOR.checkpoints[checkpoint];
  if (!entry) throw new Error("Missing Harbor checkpoint");
  return {
    tickLimit: HARBOR.maxTicks,
    terrain: structuredClone([...HARBOR_TERRAIN]),
    destructibles: [],
    enemyBounds: { x: 0, y: -pixels(64), w: pixels(HARBOR.width), h: pixels(512) },
    fallBoundary: pixels(HARBOR.fallBoundary),
    entry: { x: pixels(entry.x), y: pixels(entry.y) },
    activeEnemyIds: new Set(),
    extraHurtboxes: [],
  };
}
