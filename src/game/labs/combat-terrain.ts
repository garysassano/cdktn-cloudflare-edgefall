import type { DestructibleDefinition, DestructibleState } from "../combat/destructible.js";
import type { MaterialSurface } from "../content/materials.js";
import {
  MATERIAL_CALIBRATION,
  materialCase,
  materialLabProp,
  materialPlayerX,
} from "../content/scenarios/materials.js";
import { integer, pixels } from "../core/numeric.js";
import { type CollisionFrame, CollisionGrid, CollisionIndex } from "../physics/grid.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { CombatLab, CombatStage } from "./combat.js";
import type { CombatScenario } from "./combat-scenarios.js";
import { footTerrain } from "./foot-fixture.js";

/** An authored scaffold spans a real void. Infantry stands above its damageable face. */
export const COMBAT_SUPPORT: readonly DestructibleDefinition[] = [
  {
    id: 104,
    definitionId: 1,
    rect: { x: pixels(176), y: pixels(160), w: pixels(152), h: pixels(56) },
    health: 8,
    materialId: "timber",
  },
];
export function combatGeometryRevision(props: readonly DestructibleState[]): number {
  return 1 + props.filter((prop) => prop.health === 0).length;
}
export function combatDestructibles(scenario: CombatScenario): readonly DestructibleDefinition[] {
  const definition = materialCase(scenario);
  return definition ? [materialLabProp(definition)] : scenario === "support" ? COMBAT_SUPPORT : [];
}
export function materialCombatStage(
  world: Pick<CombatLab, "scenario" | "tick" | "props" | "targets">,
): CombatStage | undefined {
  const definition = materialCase(world.scenario);
  if (!definition) return;
  return {
    terrain: combatTerrain(world.scenario, world.tick + 1, world.props),
    destructibles: combatDestructibles(world.scenario),
    enemyBounds: { ...MATERIAL_CALIBRATION.bounds },
    fallBoundary: MATERIAL_CALIBRATION.fallBoundary,
    entry: { x: materialPlayerX(definition.weapon), y: MATERIAL_CALIBRATION.targetY },
    activeEnemyIds: new Set(world.targets.map((target) => target.enemy.body.id)),
    patrolSpeed: definition.targetMotion === "stationary" ? 0 : MATERIAL_CALIBRATION.patrolSpeed,
    extraHurtboxes: [],
  };
}

/** Engineering lift and press: deterministic world-tick trajectories, including their stops. */
export const COMBAT_ORDNANCE = [
  {
    id: 102,
    shapeId: 17,
    x: pixels(24),
    y: pixels(160),
    w: pixels(240),
    h: pixels(8),
    start: 0,
    end: 50,
    dx: pixels(1),
    dy: 0,
  },
  {
    id: 103,
    shapeId: 18,
    x: pixels(190),
    y: pixels(90),
    w: pixels(132),
    h: pixels(10),
    start: 55,
    end: 85,
    dx: 0,
    dy: pixels(2),
  },
] as const;

export function ordnancePlatforms(tick: number) {
  integer(tick, 0, 3601, "ordnance trajectory tick");
  return COMBAT_ORDNANCE.map((platform, i) => {
    const age = Math.max(0, Math.min(platform.end, tick) - platform.start);
    const previous = Math.max(0, Math.min(platform.end, Math.max(0, tick - 1)) - platform.start);
    return {
      id: platform.id,
      x: platform.x + age * platform.dx,
      y: platform.y + age * platform.dy,
      vx: (age - previous) * platform.dx,
      vy: (age - previous) * platform.dy,
      shapeId: platform.shapeId,
      trajectoryId: i + 1,
      trajectoryTick: tick,
    };
  });
}

/** Geometry at the start of this simulation tick, with exact motion through its end. */
export function combatTerrain(
  scenario: CombatScenario,
  tick = 0,
  props: readonly DestructibleState[] = [],
): MaterialSurface[] {
  const material = materialCase(scenario);
  if (material) {
    const definition = materialLabProp(material);
    if (
      props.length !== 1 ||
      props[0]?.id !== definition.id ||
      props[0].definitionId !== definition.definitionId
    )
      throw new Error("Missing material geometry state");
    return [
      footTerrain(100, 0, 200, 384, 16),
      ...props
        .filter((prop) => prop.health > 0)
        .map((prop) => ({
          id: prop.id,
          kind: "solid" as const,
          materialId: definition.materialId,
          rect: { ...definition.rect },
          delta: { x: 0, y: 0 },
        })),
    ];
  }
  if (scenario === "support") {
    if (props.length !== COMBAT_SUPPORT.length) throw new Error("Missing support state");
    return [
      footTerrain(100, 0, 200, 152, 16),
      ...props
        .filter((prop) => prop.health > 0)
        .map((prop) => {
          const definition = COMBAT_SUPPORT.find((definition) => definition.id === prop.id);
          if (!definition) throw new Error("Unknown support geometry");
          return {
            id: prop.id,
            kind: "solid" as const,
            materialId: definition.materialId,
            rect: { ...definition.rect },
            delta: { x: 0, y: 0 },
          };
        }),
      footTerrain(105, 352, 200, 32, 16),
    ];
  }
  const terrain = [
    footTerrain(100, 0, 200, 384, 16),
    ...(scenario === "wall" ? [footTerrain(101, 140, 130, 3, 70)] : []),
  ];
  if (scenario === "ordnance")
    for (const [i, platform] of ordnancePlatforms(tick).entries()) {
      const definition = COMBAT_ORDNANCE[i];
      if (!definition) throw new Error("Missing ordnance platform");
      terrain.push({
        id: platform.id,
        kind: "solid",
        rect: {
          x: platform.x - platform.vx,
          y: platform.y - platform.vy,
          w: definition.w,
          h: definition.h,
        },
        delta: { x: platform.vx, y: platform.vy },
      });
    }
  return terrain;
}

/** Rendering and hand releases occur after the accepted movement boundary. */
export function combatEndTerrain(
  scenario: CombatScenario,
  tick: number,
  props: readonly DestructibleState[] = [],
): MaterialSurface[] {
  return combatTerrain(scenario, tick, props).map((target) => ({
    ...target,
    rect: { ...target.rect, x: target.rect.x + target.delta.x, y: target.rect.y + target.delta.y },
    delta: { x: 0, y: 0 },
  }));
}

export function combatCollisionIndex(
  scenario: CombatScenario,
  frame: CollisionFrame,
  props: readonly DestructibleState[] = [],
  terrainOverride?: SweepTarget[],
) {
  const terrain = terrainOverride ?? combatTerrain(scenario, frame.tick, props);
  const moving = (target: SweepTarget) => target.delta.x !== 0 || target.delta.y !== 0;
  return new CollisionIndex(
    new CollisionGrid(terrain.filter((target) => !moving(target))),
    terrain.filter(moving),
    frame,
  );
}
