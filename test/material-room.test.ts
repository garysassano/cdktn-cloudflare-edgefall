import { describe, expect, it } from "vitest";
import {
  MATERIAL_CASES,
  MATERIAL_SCENARIOS,
  type MaterialLabDefinition,
  materialScenario,
} from "../src/game/content/scenarios/materials.js";
import { canonical } from "../src/game/core/canonical.js";
import {
  COMBAT_SCENARIOS,
  combatScenarioFromId,
  combatScenarioId,
} from "../src/game/labs/combat-scenarios.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  validateCombatCheckpoint,
} from "../src/shared/diagnostics/combat-checkpoint.js";
import { createCombatRuntime } from "../src/shared/diagnostics/combat-runtime.js";
import {
  combatPeerContext,
  combatSnapshotScenario,
  validateCombatGeometryTransition,
} from "../src/shared/diagnostics/combat-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";
import { materialRoomProof, recordMaterialRoom } from "./fixtures/material-room-proof.js";

const laser: MaterialLabDefinition = {
  weapon: "laser",
  materialId: "armor-steel",
  targetMotion: "stationary",
  players: 4,
};
describe("registered authoritative material scenarios", () => {
  it("uses unique registered IDs and validates every baseline for all four party sizes", () => {
    expect(COMBAT_SCENARIOS).toHaveLength(78);
    expect(new Set(COMBAT_SCENARIOS).size).toBe(78);
    expect(MATERIAL_SCENARIOS).toHaveLength(64);
    for (const scenario of COMBAT_SCENARIOS)
      expect(combatScenarioFromId(combatScenarioId(scenario))).toBe(scenario);
    expect(combatScenarioId(materialScenario(laser))).toBe(59);
    for (const definition of MATERIAL_CASES)
      for (const players of [1, 2, 3, 4]) {
        const scenario = materialScenario(definition),
          state = createCombatRuntime(scenario, players),
          context = combatPeerContext(state.snapshot, 0);
        validateCombatCheckpoint(state);
        const snapshot = decodeSnapshot(encodeSnapshot(state.snapshot, context), context);
        expect(combatSnapshotScenario(snapshot)).toBe(scenario);
        expect(snapshot.enemies.map((enemy) => [enemy.definitionId, enemy.health])).toEqual([
          [5, 32],
          [5, 32],
        ]);
        expect(snapshot.players).toHaveLength(players);
        expect(snapshot.acknowledgments).toHaveLength(players);
      }
    for (const id of [0, 79, 1.5, Number.NaN]) expect(() => combatScenarioFromId(id)).toThrow();
  });
  it("retains loaded scenario identity after cover is gone and rejects another valid case", () => {
    const fixture = recordMaterialRoom(laser),
      state = fixture.states[12];
    if (!state || !state.snapshot.combat) throw new Error("Missing destroyed material boundary");
    expect(state.combat.props[0]?.health).toBe(0);
    const context = combatPeerContext(state.snapshot, 0);
    expect(
      combatSnapshotScenario(decodeSnapshot(encodeSnapshot(state.snapshot, context), context)),
    ).toBe(materialScenario(laser));
    const incoming = structuredClone(state.snapshot);
    if (!incoming.combat) throw new Error("Missing material baseline");
    incoming.combat.scenarioId = combatScenarioId(
      materialScenario({ ...laser, weapon: "sidearm" }),
    );
    expect(() => encodeSnapshot(incoming, context)).toThrow(/scenario/);
    expect(() => validateCombatGeometryTransition(state.snapshot, incoming)).toThrow(/scenario/);
    incoming.combat.scenarioId = 0;
    expect(() => encodeSnapshot(incoming, context)).toThrow();
  });
  it("does not accept calibration health on ordinary infantry or another prop material", () => {
    const state = createCombatRuntime(materialScenario(laser), 4);
    const normal = createCombatRuntime("range", 1);
    const target = normal.combat.targets[0];
    if (!target) throw new Error("Missing ordinary target");
    target.health = 32;
    expect(() => validateCombatCheckpoint(normal)).toThrow(/health/);
    const changed = structuredClone(state),
      calibration = changed.combat.targets[0];
    if (!calibration) throw new Error("Missing calibration target");
    calibration.health = 33;
    expect(() => validateCombatCheckpoint(changed)).toThrow(/health/);
    const prop = state.combat.props[0];
    if (!prop) throw new Error("Missing material prop");
    prop.definitionId = 11;
    expect(() => validateCombatCheckpoint(state)).toThrow(/definition/i);
    const snapshot = createCombatRuntime(materialScenario(laser), 4).snapshot,
      enemy = snapshot.enemies[0];
    if (!enemy) throw new Error("Missing public calibration target");
    enemy.definitionId = 1;
    expect(() => encodeSnapshot(snapshot, combatPeerContext(snapshot, 0))).toThrow(/calibration/);
  });
  it("rejects previous archives and world formats and refuses a changed private scene", async () => {
    const state = createCombatRuntime(materialScenario(laser), 4),
      identity = await combatArchiveIdentity();
    const raw = await encodeCombatCheckpoint(state, identity),
      envelope = JSON.parse(raw);
    envelope.format = 16;
    await expect(decodeCombatCheckpoint(JSON.stringify(envelope), identity)).rejects.toThrow();
    const changed = structuredClone(state);
    changed.combat.scenario = materialScenario({ ...laser, weapon: "sidearm" });
    expect(() => validateCombatCheckpoint(changed)).toThrow();
    const old = JSON.parse(canonical(state));
    old.combat.format = 13;
    expect(() => validateCombatCheckpoint(old)).toThrow(/format/);
  });
  it.each([
    { weapon: "sidearm", materialId: "concrete", targetMotion: "stationary", players: 1 },
    { weapon: "heavy-machine-gun", materialId: "armor-steel", targetMotion: "patrol", players: 4 },
    { weapon: "shotgun", materialId: "timber", targetMotion: "stationary", players: 4 },
    { weapon: "rocket-launcher", materialId: "open-grating", targetMotion: "patrol", players: 4 },
    { weapon: "flamethrower", materialId: "timber", targetMotion: "stationary", players: 4 },
    { weapon: "laser", materialId: "armor-steel", targetMotion: "patrol", players: 4 },
    { weapon: "knife", materialId: "timber", targetMotion: "stationary", players: 1 },
    { weapon: "grenade", materialId: "open-grating", targetMotion: "patrol", players: 1 },
  ] as MaterialLabDefinition[])(
    "preserves $weapon actions through admitted input, wire and archive replay",
    async (definition) => {
      const proof = await materialRoomProof([definition]),
        result = proof.cases[0];
      expect(result?.checkpoints).toHaveLength(3);
      expect(result?.duplicates).toBe(120 * definition.players);
      expect(result?.players.every((player) => player.lives === 3)).toBe(true);
    },
  );
});
