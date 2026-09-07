import assert from "node:assert/strict";
import type { ShieldState } from "../../src/game/actors/shield.js";
import type { EventEnvelope } from "../../src/shared/protocol/events.js";
import { SHIELD_BOUNDARIES } from "../../test/fixtures/shield-proof.js";

export async function verifyStoredShield(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const scenarios = [];
  for (const mode of ["bash", "break"] as const) {
    const request = async (action: string) => {
      const response = await fetch(`${await origin()}/shield-${mode}/${action}`, {
        method: "POST",
      });
      assert(response.ok, `Stored shield ${mode}/${action}: ${await response.clone().text()}`);
      return (await response.json()) as {
        instance: string;
        tick: number;
        hash: string;
        guard: ShieldState;
        archiveRows: number;
        checkpointTick: number;
        health: number;
        events: EventEnvelope[];
        players: { lives: number; grenadeStock: number }[];
        encounter: string;
      };
    };
    const boundaries = [];
    for (const tick of [...SHIELD_BOUNDARIES[mode], 180]) {
      const saved = await request(String(tick));
      assert.equal(saved.tick, tick);
      assert(saved.archiveRows <= 6, "Partial segments exceeded bounded recovery rows");
      if (mode === "bash" && tick === 56)
        assert.equal(saved.checkpointTick, 56, "The fifth short segment must compact");
      await restart();
      const cold = await request("restore");
      assert.notEqual(cold.instance, saved.instance);
      assert.deepEqual({ ...cold, instance: saved.instance }, saved);
      if (mode === "bash") {
        if (tick === 30 || tick === 33) assert.deepEqual(saved.guard.hitIds, [1, 2, 3]);
        if (tick === 56 || tick === 57) assert.equal(saved.guard.facing, tick === 56 ? -1 : 1);
      } else {
        if (tick === 95) {
          assert.equal(saved.health, 1);
          assert.equal(saved.guard.integrity, 0);
          assert.equal(saved.guard.phase, "stunned");
          assert(saved.players.every((player) => player.lives === 3 && player.grenadeStock === 9));
          assert.equal(saved.events.filter(({ event }) => event.kind === "shield-break").length, 1);
        }
        if (tick === 130) assert.equal(saved.guard.phase, "stunned");
        if (tick === 131) assert.notEqual(saved.guard.phase, "stunned");
        if (tick === 180) assert.equal(saved.encounter, "complete");
      }
      boundaries.push({ saved, coldInstance: cold.instance });
    }
    scenarios.push({ mode, boundaries });
  }
  return {
    scenarios,
    rollback:
      "Every journal segment fails inside SQLite before an unchanged-prefix check, commit and cold process restore; bash hit ledger, committed turn and permanently broken shield are retained",
  };
}
