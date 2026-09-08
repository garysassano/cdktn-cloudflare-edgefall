import type { DestructibleDefinition } from "../../combat/destructible.js";
import { integer, pixels } from "../../core/numeric.js";
import { SURFACE_MATERIAL_IDS, type SurfaceMaterialId, surfaceMaterial } from "../materials.js";

export const MATERIAL_LAB_WEAPONS = [
  "sidearm",
  "heavy-machine-gun",
  "shotgun",
  "rocket-launcher",
  "flamethrower",
  "laser",
  "knife",
  "grenade",
] as const;
export const MATERIAL_TARGET_MOTIONS = ["stationary", "patrol"] as const;
export interface MaterialCase {
  weapon: (typeof MATERIAL_LAB_WEAPONS)[number];
  materialId: SurfaceMaterialId;
  targetMotion: (typeof MATERIAL_TARGET_MOTIONS)[number];
}
export interface MaterialLabDefinition extends MaterialCase {
  players: number;
}
export type MaterialScenario =
  `material:${MaterialCase["weapon"]}:${SurfaceMaterialId}:${MaterialCase["targetMotion"]}`;

export const MATERIAL_CASES: readonly Readonly<MaterialCase>[] = MATERIAL_LAB_WEAPONS.flatMap(
  (weapon) =>
    SURFACE_MATERIAL_IDS.flatMap((materialId) =>
      MATERIAL_TARGET_MOTIONS.map((targetMotion) => ({ weapon, materialId, targetMotion })),
    ),
);
export function materialScenario(definition: MaterialCase): MaterialScenario {
  if (
    !MATERIAL_LAB_WEAPONS.includes(definition.weapon) ||
    !MATERIAL_TARGET_MOTIONS.includes(definition.targetMotion)
  )
    throw new Error("Unknown material calibration case");
  surfaceMaterial(definition.materialId);
  return `material:${definition.weapon}:${definition.materialId}:${definition.targetMotion}`;
}
export const MATERIAL_SCENARIOS = MATERIAL_CASES.map(materialScenario);
const cases = new Map(
  MATERIAL_SCENARIOS.map((scenario, index) => [scenario, MATERIAL_CASES[index]]),
);
export function materialCase(scenario: string): Readonly<MaterialCase> | null {
  return cases.get(scenario as MaterialScenario) ?? null;
}
export const MATERIAL_CALIBRATION = {
  definitionId: 5,
  firstTargetX: pixels(112),
  targetSpacing: pixels(24),
  targetY: pixels(200),
  targetHealth: 32,
  patrolSpeed: 64,
  bounds: { x: 0, y: 0, w: pixels(384), h: pixels(232) },
  fallBoundary: pixels(248),
} as const;
export function materialPlayerX(weapon: MaterialCase["weapon"]): number {
  return pixels(weapon === "knife" ? 70 : weapon === "grenade" ? 10 : 45);
}
export function materialLabProp(definition: MaterialCase): DestructibleDefinition {
  surfaceMaterial(definition.materialId);
  return {
    id: 200,
    definitionId: 10 + SURFACE_MATERIAL_IDS.indexOf(definition.materialId),
    materialId: definition.materialId,
    rect: { x: pixels(92), y: pixels(80), w: pixels(2), h: pixels(120) },
    health: 8,
  };
}
export function validateMaterialDefinition(definition: MaterialLabDefinition) {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    Object.keys(definition).sort().join() !== "materialId,players,targetMotion,weapon"
  )
    throw new Error("Invalid material laboratory definition");
  materialScenario(definition);
  integer(definition.players, 1, 4, "material laboratory players");
}
