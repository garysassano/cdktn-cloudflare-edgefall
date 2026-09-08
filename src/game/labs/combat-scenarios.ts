import { MATERIAL_SCENARIOS } from "../content/scenarios/materials.js";
import { integer } from "../core/numeric.js";

/** Registered content IDs are sent in snapshots; a prop count is not a scene identity. */
export const COMBAT_SCENARIOS = [
  "range",
  "wall",
  "shield",
  "rifle",
  "guard",
  "shotgun",
  "flame",
  "tank",
  "ordnance",
  "hmg",
  "support",
  "rocket",
  "laser",
  "pickups",
  ...MATERIAL_SCENARIOS,
] as const;
export type CombatScenario = (typeof COMBAT_SCENARIOS)[number];
export function isCombatScenario(value: unknown): value is CombatScenario {
  return typeof value === "string" && COMBAT_SCENARIOS.some((scenario) => scenario === value);
}
export function combatScenarioId(scenario: CombatScenario): number {
  const id = COMBAT_SCENARIOS.indexOf(scenario) + 1;
  if (id === 0) throw new Error("Unknown combat scenario");
  return id;
}
export function combatScenarioFromId(id: number): CombatScenario {
  integer(id, 1, COMBAT_SCENARIOS.length, "registered combat scenario");
  const scenario = COMBAT_SCENARIOS[id - 1];
  if (!scenario) throw new Error("Missing combat scenario content");
  return scenario;
}
