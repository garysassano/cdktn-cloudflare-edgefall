import { describe, expect, it } from "vitest";
import { Held } from "../src/game/input/types.js";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { combatSnapshot } from "../src/shared/diagnostics/combat-workload.js";
import { probeContext } from "../src/shared/diagnostics/room-workload.js";
import { Reader, Writer } from "../src/shared/protocol/binary.js";
import {
  COMBAT_HEADER_BYTES,
  combatRecordBytes,
  readCombat,
  writeCombat,
} from "../src/shared/protocol/combat-record.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import type { CombatSnapshot, FullSnapshot } from "../src/shared/protocol/snapshot-schema.js";
import goldens from "./fixtures/protocol-v3/combat-golden.json" with { type: "json" };

function baseline(ticks = 24) {
  let world = createCombatLab("range", 4);
  for (let tick = 1; tick <= ticks; tick++)
    world = stepCombatLab(
      world,
      world.players.map(() => ({ held: Held.Fire, jumpPressed: false, firePressed: tick === 1 })),
    );
  return combatSnapshot(world);
}
const context = probeContext(0);
describe("combat baseline accounting", () => {
  it.each(goldens)("matches the independent $name section golden", (golden) => {
    const writer = new Writer(golden.byteLength);
    writeCombat(writer, golden.combat as CombatSnapshot);
    expect(Buffer.from(writer.bytes).toString("hex")).toBe(golden.hex);
    expect(writer.offset).toBe(golden.byteLength);
    expect(readCombat(new Reader(Buffer.from(golden.hex, "hex")))).toEqual(golden.combat);
  });
  it("restores completion and kill credits without replaying any historical effects", () => {
    const source = baseline();
    const decoded = decodeSnapshot(encodeSnapshot(source, context), context);
    expect(decoded).toEqual(source);
    expect(decoded.combat).toMatchObject({
      phase: "complete",
      encounterEventCursor: 4,
      kills: [
        { playerId: 1, count: 0 },
        { playerId: 2, count: 2 },
        { playerId: 3, count: 0 },
        { playerId: 4, count: 0 },
      ],
    });
    expect(decoded.combat?.members.map((m) => [m.status, m.reason, m.killerId])).toEqual([
      ["resolved", "killed", 2],
      ["resolved", "killed", 2],
    ]);
    expect(decoded.campaign.phase).toBe("playing");
    expect(decoded.campaign.remainingEnemies).toBe(0);
  });
  it("keeps pending activation, null ticks and tick zero distinct", () => {
    const snapshot = baseline(0);
    const member = snapshot.combat?.members[0];
    if (!member) throw new Error("Missing member");
    expect(decodeSnapshot(encodeSnapshot(snapshot, context), context)).toEqual(snapshot);
    member.activatedTick = 0;
    member.status = "alive";
    expect(
      decodeSnapshot(encodeSnapshot(snapshot, context), context).combat?.members[0]?.activatedTick,
    ).toBe(0);
  });
  it("rejects inconsistent ledger, allocator and terminal state before exposure", () => {
    const mutations: Array<(s: FullSnapshot) => void> = [
      (s) => {
        if (s.combat) s.combat.nextEntityId = s.projectiles[0]?.id ?? 20;
      },
      (s) => {
        if (s.combat) s.combat.nextActionId = s.players[0]?.weapon.lastActionInstanceId ?? 1;
      },
      (s) => {
        if (s.combat?.kills[1]) s.combat.kills[1].count++;
      },
      (s) => {
        if (s.combat?.members[0]) s.combat.members[0].killerId = 99;
      },
      (s) => {
        if (s.combat?.members[0]) s.combat.members[0].activatedTick = 25;
      },
      (s) => {
        if (s.combat?.members[0]) s.combat.members[0].reason = null;
      },
      (s) => {
        if (s.combat) s.combat.encounterId++;
      },
      (s) => {
        if (s.combat) s.combat.phase = "failed";
      },
      (s) => {
        s.campaign.remainingEnemies = 1;
      },
      (s) => {
        if (s.combat?.members[0]) s.combat.members.push(structuredClone(s.combat.members[0]));
      },
    ];
    for (const mutate of mutations) {
      const snapshot = baseline();
      mutate(snapshot);
      expect(() => encodeSnapshot(snapshot, context)).toThrow();
    }
  });
  it("rejects unsupported versions/flags, oversized tables, padding and every truncated section", () => {
    const snapshot = baseline();
    const bytes = encodeSnapshot(snapshot, context);
    const start = bytes.length - combatRecordBytes(snapshot.combat);
    for (const [offset, value] of [
      [3, 0],
      [5, 2],
      [start, 2],
      [start + 2, 44],
      [start + 25, 2],
      [start + 30, 1],
      [start + COMBAT_HEADER_BYTES + 28, 1],
    ]) {
      if (offset === undefined || value === undefined) throw new Error("Invalid mutation");
      const corrupt = bytes.slice();
      corrupt[offset] = value;
      expect(() => decodeSnapshot(corrupt, context)).toThrow();
    }
    for (let n = start; n < bytes.length; n++) {
      const corrupt = bytes.slice(0, n);
      new DataView(corrupt.buffer).setUint16(6, n, true);
      expect(() => decodeSnapshot(corrupt, context)).toThrow();
    }
  });
});
