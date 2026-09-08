import { type DestructibleDefinition, createDestructible } from "../combat/destructible.js";
import {
  SURFACE_MATERIALS,
  SURFACE_MATERIAL_IDS,
  type SurfaceMaterialId,
  surfaceMaterial,
} from "../content/materials.js";
import { LASER_PROFILE } from "../content/weapons/laser.js";
import { ROCKET_PROFILE } from "../content/weapons/rocket-launcher.js";
import { canonical, stateHash } from "../core/canonical.js";
import { integer, pixels } from "../core/numeric.js";
import { Held } from "../input/types.js";
import {
  type CombatCommand,
  type CombatLab,
  type CombatStage,
  advanceCombatLab,
  createCombatLab,
} from "./combat.js";
import {
  AREA_PROFILES,
  COMBAT_CONTENT,
  FOOT_ACTION_PROFILES,
  GRENADE_PROFILE,
  HMG_SWEEP,
} from "./combat-content.js";
import { footTerrain } from "./foot-fixture.js";

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
export interface MaterialLabDefinition {
  weapon: (typeof MATERIAL_LAB_WEAPONS)[number];
  materialId: SurfaceMaterialId;
  players: number;
  targetMotion: "stationary" | "patrol";
}
export interface MaterialLab {
  format: 1;
  definition: MaterialLabDefinition;
  world: CombatLab;
}
export function materialLabProp(definition: MaterialLabDefinition): DestructibleDefinition {
  surfaceMaterial(definition.materialId);
  return {
    id: 200,
    definitionId: 10 + SURFACE_MATERIAL_IDS.indexOf(definition.materialId),
    materialId: definition.materialId,
    rect: { x: pixels(92), y: pixels(80), w: pixels(2), h: pixels(120) },
    health: 8,
  };
}
function validateDefinition(definition: MaterialLabDefinition) {
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition) ||
    Object.keys(definition).sort().join() !== "materialId,players,targetMotion,weapon" ||
    !MATERIAL_LAB_WEAPONS.includes(definition.weapon) ||
    !["stationary", "patrol"].includes(definition.targetMotion)
  )
    throw new Error("Invalid material laboratory definition");
  integer(definition.players, 1, 4, "material laboratory players");
  surfaceMaterial(definition.materialId);
}
/** Calibration dummies have 32 HP; ordinary campaign infantry remains unchanged. */
export function createMaterialLab(definition: MaterialLabDefinition): MaterialLab {
  validateDefinition(definition);
  const world = createCombatLab("range", definition.players);
  const weaponId =
    definition.weapon === "knife" || definition.weapon === "grenade"
      ? "sidearm"
      : definition.weapon;
  const weapon = COMBAT_CONTENT.weapons.find((weapon) => weapon.id === weaponId);
  if (!weapon) throw new Error("Missing material laboratory weapon");
  for (const actor of world.players) {
    actor.body.x = pixels(
      definition.weapon === "knife" ? 70 : definition.weapon === "grenade" ? 10 : 45,
    );
    actor.weapon.id = weapon.id;
    actor.weapon.ammo = weapon.pickupAmmo === "unlimited" ? 0 : weapon.pickupAmmo;
  }
  for (const [index, target] of world.targets.entries()) {
    target.enemy.body.x = pixels(112 + index * 24);
    target.health = 32;
  }
  world.props = [createDestructible(materialLabProp(definition))];
  return { format: 1, definition: { ...definition }, world };
}
export function materialLabStage(lab: MaterialLab): CombatStage {
  const definition = materialLabProp(lab.definition);
  return {
    terrain: [
      footTerrain(100, 0, 200, 384, 16),
      ...lab.world.props
        .filter((prop) => prop.health > 0)
        .map((prop) => ({
          id: prop.id,
          kind: "solid" as const,
          materialId: definition.materialId,
          rect: { ...definition.rect },
          delta: { x: 0, y: 0 },
        })),
    ],
    destructibles: [definition],
    enemyBounds: { x: 0, y: 0, w: pixels(384), h: pixels(232) },
    fallBoundary: pixels(248),
    entry: { x: pixels(45), y: pixels(200) },
    activeEnemyIds: new Set(lab.world.targets.map((target) => target.enemy.body.id)),
    patrolSpeed: lab.definition.targetMotion === "stationary" ? 0 : 64,
    extraHurtboxes: [],
  };
}
export function stepMaterialLab(
  current: MaterialLab,
  commands: readonly CombatCommand[],
): MaterialLab {
  validateDefinition(current.definition);
  if (current.format !== 1 || current.world.players.length !== current.definition.players)
    throw new Error("Material laboratory format/roster mismatch");
  return {
    format: 1,
    definition: { ...current.definition },
    world: advanceCombatLab(current.world, commands, undefined, materialLabStage(current)).state,
  };
}
/** One accepted onset, with neutral continuation. Grenades use the real crouched throw action. */
export function materialLabCommands(lab: MaterialLab): CombatCommand[] {
  return lab.world.players.map(() => ({
    held: lab.definition.weapon === "grenade" ? Held.Down : 0,
    firePressed: lab.definition.weapon !== "grenade" && lab.world.tick === 0,
    jumpPressed: false,
    grenadePressed: lab.definition.weapon === "grenade" && lab.world.tick === 0,
    interactPressed: false,
  }));
}

export interface MaterialRecording {
  format: 1;
  kind: "material-lab";
  contentFingerprint: string;
  definition: MaterialLabDefinition;
  commands: CombatCommand[][];
  finalState: string;
}
/** Local import compatibility fingerprint; durable archives use their separate SHA-256 contract. */
export function materialLabFingerprint(definition: MaterialLabDefinition): string {
  const initial = createMaterialLab(definition),
    stage = materialLabStage(initial);
  return stateHash({
    initial,
    stage: { ...stage, activeEnemyIds: [...stage.activeEnemyIds] },
    content: COMBAT_CONTENT,
    surfaces: SURFACE_MATERIALS,
    areas: [...AREA_PROFILES],
    footActions: FOOT_ACTION_PROFILES,
    grenade: GRENADE_PROFILE,
    hmg: HMG_SWEEP,
    laser: LASER_PROFILE,
    rocket: ROCKET_PROFILE,
  });
}
export function createMaterialRecording(
  lab: MaterialLab,
  commands: CombatCommand[][],
): MaterialRecording {
  if (commands.length !== lab.world.tick) throw new Error("Material recording boundary mismatch");
  return {
    format: 1,
    kind: "material-lab",
    contentFingerprint: materialLabFingerprint(lab.definition),
    definition: { ...lab.definition },
    commands: structuredClone(commands),
    finalState: canonical(lab),
  };
}
export function replayMaterialLab(
  recording: MaterialRecording,
  observe?: (lab: MaterialLab) => void,
): MaterialLab {
  if (
    !recording ||
    typeof recording !== "object" ||
    Array.isArray(recording) ||
    Object.keys(recording).sort().join() !==
      "commands,contentFingerprint,definition,finalState,format,kind" ||
    recording.format !== 1 ||
    recording.kind !== "material-lab" ||
    !Array.isArray(recording.commands) ||
    recording.commands.length > 3600 ||
    typeof recording.finalState !== "string" ||
    recording.finalState.length > 2 ** 21 ||
    recording.contentFingerprint !== materialLabFingerprint(recording.definition)
  )
    throw new Error("Invalid or incompatible material recording");
  let state = createMaterialLab(recording.definition);
  observe?.(structuredClone(state));
  for (const commands of recording.commands) {
    if (
      !Array.isArray(commands) ||
      commands.some(
        (command) =>
          !command ||
          typeof command !== "object" ||
          Array.isArray(command) ||
          Object.keys(command).sort().join() !==
            "firePressed,grenadePressed,held,interactPressed,jumpPressed",
      )
    )
      throw new Error("Invalid material recording command");
    state = stepMaterialLab(state, commands);
    observe?.(structuredClone(state));
  }
  if (canonical(state) !== recording.finalState)
    throw new Error("Material recording replay diverged");
  return state;
}
