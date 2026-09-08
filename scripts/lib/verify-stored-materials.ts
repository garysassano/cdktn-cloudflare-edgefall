import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonical } from "../../src/game/core/canonical.js";
import {
  type CombatRuntime,
  combatRuntimeHash,
} from "../../src/shared/diagnostics/combat-runtime.js";
import {
  MATERIAL_ROOM_CASES,
  MATERIAL_ROOM_STORAGE_BOUNDARIES,
  recordMaterialRoom,
} from "../../test/fixtures/material-room-proof.js";

interface StoredMaterial {
  instance: string;
  rollbackChecks: number;
  state: CombatRuntime;
  rows: Array<{ key: string; tick: number; runEpoch: number }>;
}

export async function verifyStoredMaterials(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const cases = [];
  const request = async (index: number, action: number | "restore") => {
    const response = await fetch(`${await origin()}/storage/${index}/${action}`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    assert(response.ok, `Material ${index}/${action}: ${await response.clone().text()}`);
    return (await response.json()) as StoredMaterial;
  };
  // Each group bounds host memory while every saved boundary crosses a complete workerd restart.
  for (let offset = 0; offset < MATERIAL_ROOM_CASES.length; offset += 16) {
    const group = MATERIAL_ROOM_CASES.slice(offset, offset + 16).map((definition, slot) => ({
      index: offset + slot,
      definition,
      fixture: recordMaterialRoom(definition),
      boundaries: [] as Array<{
        tick: number;
        instance: string;
        coldInstance: string;
        hash: string;
        stateSha256: string;
        rows: StoredMaterial["rows"];
        rollbackChecks: number;
        scenarioId: number | undefined;
        props: CombatRuntime["combat"]["props"];
        health: number[];
        weapons: CombatRuntime["combat"]["players"][number]["weapon"][];
      }>,
    }));
    for (const tick of MATERIAL_ROOM_STORAGE_BOUNDARIES) {
      const saved: StoredMaterial[] = [];
      for (const item of group) {
        const current = await request(item.index, tick),
          expected = item.fixture.states[tick];
        assert(expected);
        assert.equal(
          canonical(current.state),
          canonical(expected),
          "SQLite changed accepted material state",
        );
        assert(current.rows.length <= 6);
        assert(current.rollbackChecks >= 1, "Boundary did not exercise transaction rollback");
        saved.push(current);
      }
      await restart();
      for (const [slot, item] of group.entries()) {
        const cold = await request(item.index, "restore"),
          current = saved[slot];
        assert(current);
        assert.notEqual(
          cold.instance,
          current.instance,
          "Material Durable Object instance was reused",
        );
        assert.equal(
          canonical(cold.state),
          canonical(current.state),
          "Cold material continuation diverged",
        );
        assert.deepEqual(cold.rows, current.rows);
        item.boundaries.push({
          tick,
          instance: current.instance,
          coldInstance: cold.instance,
          hash: combatRuntimeHash(cold.state),
          stateSha256: createHash("sha256").update(canonical(cold.state)).digest("hex"),
          rows: cold.rows,
          rollbackChecks: current.rollbackChecks,
          scenarioId: cold.state.snapshot.combat?.scenarioId,
          props: cold.state.combat.props,
          health: cold.state.combat.targets.map((target) => target.health),
          weapons: cold.state.combat.players.map((player) => player.weapon),
        });
      }
    }
    for (const { fixture: _fixture, ...item } of group) cases.push(item);
    console.log(
      `SQLite material cases ${offset + group.length}/${MATERIAL_ROOM_CASES.length} passed`,
    );
  }
  return {
    cases,
    boundaryCount: cases.reduce((sum, item) => sum + item.boundaries.length, 0),
    rollbackChecks: cases.reduce(
      (sum, item) =>
        sum + item.boundaries.reduce((total, boundary) => total + boundary.rollbackChecks, 0),
      0,
    ),
    scope:
      "All 128 solo/four-player material cases. Complete private state and accepted input continuation compare exactly before and after each fresh workerd process. Seed and segment failures preserve every SQLite row before a successful commit; archives stay at six rows or fewer.",
  };
}
