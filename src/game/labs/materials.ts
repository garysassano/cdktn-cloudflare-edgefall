import { SURFACE_MATERIALS } from "../content/materials.js";
import {
  type MaterialLabDefinition,
  materialScenario,
  validateMaterialDefinition,
} from "../content/scenarios/materials.js";
import { LASER_PROFILE } from "../content/weapons/laser.js";
import { ROCKET_PROFILE } from "../content/weapons/rocket-launcher.js";
import { canonical, stateHash } from "../core/canonical.js";
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
import { materialCombatStage } from "./combat-terrain.js";

export {
  MATERIAL_LAB_WEAPONS,
  type MaterialLabDefinition,
  materialLabProp,
} from "../content/scenarios/materials.js";
export interface MaterialLab {
  format: 3;
  definition: MaterialLabDefinition;
  world: CombatLab;
}
/** Inspector creation and stepping use the same registered scenario as the authoritative room. */
export function createMaterialLab(definition: MaterialLabDefinition): MaterialLab {
  validateMaterialDefinition(definition);
  return {
    format: 3,
    definition: { ...definition },
    world: createCombatLab(materialScenario(definition), definition.players),
  };
}
export function materialLabStage(lab: MaterialLab): CombatStage {
  const stage = materialCombatStage(lab.world);
  if (!stage || lab.world.scenario !== materialScenario(lab.definition))
    throw new Error("Material inspector scenario mismatch");
  return stage;
}
export function stepMaterialLab(
  current: MaterialLab,
  commands: readonly CombatCommand[],
): MaterialLab {
  validateMaterialDefinition(current.definition);
  if (
    current.format !== 3 ||
    current.world.players.length !== current.definition.players ||
    current.world.scenario !== materialScenario(current.definition)
  )
    throw new Error("Material laboratory format/roster mismatch");
  return {
    format: 3,
    definition: { ...current.definition },
    world: advanceCombatLab(current.world, commands).state,
  };
}
/** One accepted onset, with neutral continuation. Grenades use the real crouched throw action. */
export function materialLabCommands(lab: MaterialLab): CombatCommand[] {
  return lab.world.players.map(() => ({
    held: lab.definition.weapon === "grenade" ? Held.Down : 0,
    firePressed: lab.definition.weapon !== "grenade" && lab.world.tick === 0,
    jumpPressed: false,
    grenadePressed: lab.definition.weapon === "grenade" && lab.world.tick === 0,
    specialPressed: false,
    interactPressed: false,
  }));
}

export interface MaterialRecording {
  format: 3;
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
    format: 3,
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
    recording.format !== 3 ||
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
            "firePressed,grenadePressed,held,interactPressed,jumpPressed,specialPressed",
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
