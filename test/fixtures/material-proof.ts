import { SURFACE_MATERIAL_IDS, materialBlocks } from "../../src/game/content/materials.js";
import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { COMBAT_ATTACKS } from "../../src/game/labs/combat-content.js";
import {
  MATERIAL_LAB_WEAPONS,
  type MaterialLabDefinition,
  createMaterialLab,
  createMaterialRecording,
  materialLabCommands,
  replayMaterialLab,
  stepMaterialLab,
} from "../../src/game/labs/materials.js";

export const MATERIAL_TICKS = 120;
export const MATERIAL_BOUNDARIES = [1, 12, 90] as const;
export function recordMaterialCombat(definition: MaterialLabDefinition) {
  let state = createMaterialLab(definition);
  const states = [state],
    commands = [],
    impacts = [],
    healthChanges = [];
  for (let tick = 0; tick < MATERIAL_TICKS; tick++) {
    const previous = state,
      input = materialLabCommands(state);
    commands.push(input);
    state = stepMaterialLab(state, input);
    for (const event of state.world.events)
      if (event.kind === "impact" && event.impact)
        impacts.push({
          tick: state.world.tick,
          impact: event.impact,
          coverHealthBefore: previous.world.props[0]?.health,
        });
    if (
      canonical(previous.world.props) !== canonical(state.world.props) ||
      previous.world.targets.some(
        (target, index) => target.health !== state.world.targets[index]?.health,
      )
    )
      healthChanges.push({
        tick: state.world.tick,
        cover: state.world.props[0]?.health,
        targets: state.world.targets.map((target) => target.health),
      });
    states.push(state);
  }
  return { state, states, commands, impacts, healthChanges };
}
export function materialProof() {
  const cases = [];
  for (const players of [1, 4])
    for (const targetMotion of ["stationary", "patrol"] as const)
      for (const materialId of SURFACE_MATERIAL_IDS)
        for (const weapon of MATERIAL_LAB_WEAPONS) {
          const definition = { players, targetMotion, materialId, weapon },
            fixture = recordMaterialCombat(definition),
            initial = fixture.states[0];
          if (!initial) throw new Error("Missing material baseline");
          const ammunition = {
            sidearm: 0,
            "heavy-machine-gun": 149,
            shotgun: 23,
            "rocket-launcher": 19,
            flamethrower: 29,
            laser: 119,
            knife: 0,
            grenade: 0,
          };
          for (const actor of fixture.state.world.players) {
            if (
              actor.weapon.ammo !== ammunition[weapon] ||
              actor.grenadeStock !== (weapon === "grenade" ? 9 : 10) ||
              actor.weapon.shotOrdinal !== (weapon === "grenade" || weapon === "knife" ? 0 : 1) ||
              actor.lives !== 3
            )
              throw new Error(
                `Material action/inventory accounting diverged: ${canonical(definition)}`,
              );
          }
          for (const { impact, coverHealthBefore } of fixture.impacts) {
            const attack = COMBAT_ATTACKS.get(impact.definitionId);
            if (!attack) throw new Error("Unknown material impact definition");
            if (
              impact.entityId !== 200 &&
              impact.damage > 0 &&
              coverHealthBefore !== 0 &&
              materialBlocks({ materialId }, attack.material)
            )
              throw new Error(
                `Damage passed through live opaque material: ${canonical(definition)}`,
              );
          }
          const checkpoints = [];
          const recording = createMaterialRecording(fixture.state, fixture.commands);
          replayMaterialLab(JSON.parse(JSON.stringify(recording)));
          for (const tick of MATERIAL_BOUNDARIES) {
            const original = fixture.states[tick];
            if (!original) throw new Error("Missing material checkpoint");
            let restored = JSON.parse(canonical(original)) as typeof original;
            for (let i = tick; i < tick + 15; i++) {
              const command = fixture.commands[i];
              if (!command) throw new Error("Missing material continuation input");
              restored = stepMaterialLab(restored, command);
              if (canonical(restored) !== canonical(fixture.states[i + 1]))
                throw new Error("Material continuation diverged");
            }
            checkpoints.push({
              tick,
              hash: stateHash(original),
              resumedTick: restored.world.tick,
              resumedHash: stateHash(restored),
            });
          }
          cases.push({
            definition,
            ticks: MATERIAL_TICKS,
            coverHealth: fixture.state.world.props[0]?.health,
            targetHealth: fixture.state.world.targets.map((target) => target.health),
            players: fixture.state.world.players.map((actor) => ({
              playerId: actor.playerId,
              weapon: actor.weapon,
              grenadeStock: actor.grenadeStock,
              lives: actor.lives,
            })),
            impacts: fixture.impacts,
            healthChanges: fixture.healthChanges,
            checkpoints,
            finalHash: stateHash(fixture.state),
            traceHash: stateHash(fixture.states.map(stateHash)),
            recordingFingerprint: recording.contentFingerprint,
          });
        }
  return {
    cases,
    scope:
      "Actual firearm/knife/grenade actions against thin authored material cover, stationary/patrolling calibration dummies and one/four-player damage arbitration, with local recording replay and JSON continuation. The diagnostic room and exact durable archive require separate integration; this is not deployed or final-media evidence.",
  };
}
