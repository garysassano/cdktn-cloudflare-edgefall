import { describe, expect, it } from "vitest";
import { TANK_SPECIAL_ATTACK } from "../src/game/content/weapons/tank-special.js";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Edge, Held } from "../src/game/input/types.js";
import { type CombatCommand, advanceCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_SHAPES, TANK_PROFILE } from "../src/game/labs/combat-content.js";
import { footTerrain } from "../src/game/labs/foot-fixture.js";
import { stepTankCharge } from "../src/game/vehicles/tank-special.js";
import { combatAudioCues, combatAudioLoops } from "../src/shared/animation/combat-audio.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { transitionCombatRuntime } from "../src/shared/diagnostics/combat-recovery.js";
import { stageCombatRuntime } from "../src/shared/diagnostics/combat-runtime.js";
import { recordTankCombat, tankDamageInput } from "./fixtures/tank-proof.js";
import { recordTankSpecial, tankSpecialProof } from "./fixtures/tank-special-proof.js";

const idle: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  interactPressed: false,
  specialPressed: false,
};
const arming = (through = 41) =>
  recordTankCombat(
    through,
    (tick) => ({
      held: tick >= 13 ? Held.VehicleSpecial : 0,
      edges: tick === 1 ? [Edge.Interact] : tick === 13 ? [Edge.VehicleSpecial] : [],
    }),
    1,
  ).state;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing special fixture");
  return value;
};

describe("dedicated tank sacrifice", () => {
  it("requires its own onset and 30 consecutive held ticks, cancels on release, and credits one irreversible charge", () => {
    const fixture = recordTankSpecial(1),
      at = (tick: number) => required(fixture.states[tick]);
    expect(at(26).combat.tanks[0]?.special.phase).toBe("arming");
    expect(at(27).combat.tanks[0]?.special).toMatchObject({ phase: "canceled", endTick: 27 });
    expect(at(32).combat.tanks[0]?.special.phase).toBe("canceled");
    expect(at(61).combat.players[0]?.vehicleSpecialTicks).toBe(29);
    expect(at(61).combat.tanks[0]?.armor).toBe(3);
    expect(at(62).combat.tanks[0]).toMatchObject({
      lifecycle: "destroying",
      armor: 0,
      occupantId: null,
      special: { phase: "charging", startTick: 33, commitTick: 62, ownerId: 1 },
    });
    expect(at(62).combat.players[0]).toMatchObject({
      vehicleId: null,
      vehicleSpecialTicks: 0,
      lives: 3,
      controlEpoch: 4,
    });
    expect(required(at(63).combat.tanks[0]).body.x - required(at(62).combat.tanks[0]).body.x).toBe(
      pixels(6),
    );
    const blasts = fixture.states.flatMap(({ combat }) =>
      combat.events.filter((e) => e.kind === "explosion" && e.source?.definitionId === 20),
    );
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.ownerId).toBe(1);
    expect(fixture.state.combat.tanks[0]).toMatchObject({
      lifecycle: "wreck",
      special: { phase: "spent" },
    });
    expect(
      fixture.state.combat.encounter.kills.find((kill) => kill.playerId === 1)?.count,
    ).toBeGreaterThan(0);
  });

  it.each([Held.VehicleSpecial, Held.Fire])(
    "does not infer special onset from held mask %i",
    (held) => {
      const fixture = recordTankCombat(
        50,
        (tick) => ({
          held: tick >= 13 ? held : 0,
          edges:
            tick === 1
              ? [Edge.Interact]
              : tick === 13 && held === Held.Fire
                ? [Edge.Jump, Edge.FireOnset]
                : [],
        }),
        1,
      );
      expect(fixture.state.combat.tanks[0]?.special.phase).toBe("ready");
    },
  );

  it("rejects an onset whose hold was already released", () => {
    const state = arming(12).combat;
    const result = advanceCombatLab(state, [{ ...idle, specialPressed: true }]);
    expect(result.outcomes[0]?.special).toBe("unavailable");
    expect(result.state.tanks[0]?.special.phase).toBe("ready");
  });

  it.each(["pause", "recover"] as const)(
    "cancels an armed %s boundary but preserves a released charge",
    (mode) => {
      for (const tick of [41, 42]) {
        const current = arming(tick),
          next = transitionCombatRuntime(current, mode);
        validateCombatCheckpoint(next);
        expect(next.combat.tanks[0]?.special.phase).toBe(tick === 41 ? "canceled" : "charging");
        expect(next.combat.players[0]?.vehicleId).toBeNull();
        if (tick === 42)
          expect(next.combat.tanks[0]?.special).toEqual(current.combat.tanks[0]?.special);
      }
    },
  );

  it("cancels on the first missing owner connection before the seat grace period", () => {
    const next = stageCombatRuntime(arming(), []).state;
    validateCombatCheckpoint(next);
    expect(next.combat.tanks[0]?.special.phase).toBe("canceled");
    expect(next.combat.tanks[0]?.lifecycle).toBe("occupied");
    expect(next.combat.players[0]?.vehicleSpecialTicks).toBe(0);
  });

  it("lets ordinary exit cancel a simultaneous final arming tick", () => {
    const next = stepCombatLab(arming().combat, [
      { ...idle, held: Held.VehicleSpecial, interactPressed: true },
    ]);
    expect(next.tanks[0]).toMatchObject({
      lifecycle: "exiting",
      armor: 3,
      special: { phase: "canceled" },
    });
  });

  it("keeps the driver seated when every declared exit is blocked", () => {
    const state = arming().combat;
    const stage = {
      terrain: [
        footTerrain(700, -100, 200, 600, 16),
        footTerrain(701, 32, 140, 4, 60),
        footTerrain(702, 84, 140, 4, 60),
        footTerrain(703, 32, 140, 56, 4),
      ],
      destructibles: [],
      enemyBounds: { x: 0, y: 0, w: pixels(384), h: pixels(220) },
      fallBoundary: pixels(248),
      entry: { x: 0, y: 0 },
      activeEnemyIds: new Set(state.targets.map((target) => target.enemy.body.id)),
      extraHurtboxes: [],
    };
    const next = advanceCombatLab(
      state,
      [{ ...idle, held: Held.VehicleSpecial }],
      undefined,
      stage,
    ).state;
    expect(next.tanks[0]).toMatchObject({
      lifecycle: "occupied",
      armor: 3,
      special: { phase: "canceled" },
    });
    expect(next.players[0]).toMatchObject({
      vehicleSpecialTicks: 0,
      lives: 3,
      vehicleId: required(state.tanks[0]).body.id,
    });
  });

  it.each([1, 3])("damage at commitment cancels before consuming a hull with %i armor", (armor) => {
    const state = arming().combat,
      tank = required(state.tanks[0]);
    tank.armor = armor;
    state.projectiles.push({
      id: state.nextEntityId++,
      ownerId: 20,
      team: 2,
      actionInstanceId: state.nextActionId++,
      definitionId: 3,
      position: { x: tank.body.x + pixels(21), y: tank.body.y - pixels(12) },
      velocity: { x: -pixels(8), y: 0 },
      spawnTick: state.tick,
    });
    const next = stepCombatLab(state, [{ ...idle, held: Held.VehicleSpecial }]);
    expect(next.tanks[0]?.special.phase).toBe("canceled");
    expect(next.tanks[0]?.armor).toBe(armor - 1);
  });

  it("expires after 60 accepted charge ticks and cannot blast twice", () => {
    const before = required(arming(42).combat.tanks[0]);
    const tank = structuredClone(before),
      shape = required(COMBAT_SHAPES.get(tank.body.shapeId));
    for (let age = 1; age <= 60; age++) {
      const old = structuredClone(tank);
      tank.body.x += pixels(6);
      tank.body.contacts = [];
      const blast = stepTankCharge(
        old,
        tank,
        42 + age,
        TANK_SPECIAL_ATTACK,
        shape,
        TANK_PROFILE.special,
        [],
        [],
      );
      expect(blast !== null).toBe(age === 60);
    }
    expect(tank.special).toMatchObject({ phase: "spent", endTick: 102 });
    expect(
      stepTankCharge(tank, tank, 103, TANK_SPECIAL_ATTACK, shape, TANK_PROFILE.special, [], []),
    ).toBeNull();
    expect(tank.body.x - before.body.x).toBe(pixels(360));
  });

  it.each(["concrete", "open-grating"] as const)(
    "stops the physical hull at moving %s and applies its blast occlusion policy",
    (materialId) => {
      const before = required(arming(42).combat.tanks[0]),
        tank = structuredClone(before);
      tank.body.x += pixels(6);
      const shape = required(COMBAT_SHAPES.get(tank.body.shapeId));
      const wall = {
        ...footTerrain(700, 85, 130, 3, 70),
        delta: { x: -pixels(2), y: 0 },
        materialId,
      };
      const target = {
        id: 800,
        entityId: 80,
        team: 2,
        kind: "body" as const,
        rect: { x: pixels(94), y: pixels(180), w: pixels(8), h: pixels(20) },
        delta: { x: 0, y: 0 },
      };
      const blast = stepTankCharge(
        before,
        tank,
        43,
        TANK_SPECIAL_ATTACK,
        shape,
        TANK_PROFILE.special,
        [wall],
        [target],
      );
      expect(blast).not.toBeNull();
      expect(tank.body.x).toBeLessThan(before.body.x + pixels(6));
      expect(blast?.impacts.filter((impact) => impact.entityId === 80)).toHaveLength(
        materialId === "concrete" ? 0 : 1,
      );
    },
  );

  it("sweeps moving enemies, groups multiple hurtboxes and excludes the crew from the single blast", () => {
    const before = required(arming(42).combat.tanks[0]),
      tank = structuredClone(before);
    tank.body.x += pixels(6);
    const shape = required(COMBAT_SHAPES.get(tank.body.shapeId));
    const target = {
      id: 800,
      entityId: 80,
      team: 2,
      kind: "body" as const,
      rect: { x: pixels(86), y: pixels(180), w: pixels(8), h: pixels(20) },
      delta: { x: -pixels(3), y: 0 },
    };
    const blast = stepTankCharge(
      before,
      tank,
      43,
      TANK_SPECIAL_ATTACK,
      shape,
      TANK_PROFILE.special,
      [],
      [target, { ...target, id: 801 }, { ...target, id: 802, entityId: 2, team: 1 }],
    );
    expect(blast?.impacts).toHaveLength(1);
    expect(blast?.impacts[0]).toMatchObject({ entityId: 80, damage: 8, ownerId: 1 });
    expect(tank.body.x).toBe(pixels(64));
  });

  it.each([38, 41])(
    "preserves only the cannon shell already released from a tick %i action",
    (startTick) => {
      let world = arming(37).combat;
      while (world.tick < 43)
        world = stepCombatLab(world, [
          { ...idle, held: Held.VehicleSpecial, grenadePressed: world.tick + 1 === startTick },
        ]);
      expect(world.tanks[0]?.special.phase).toBe("charging");
      expect(world.tanks[0]?.secondary).toMatchObject({
        ammo: 9,
        shotsFired: 1,
        action: { kind: "ready" },
      });
      expect(world.projectiles.filter((p) => p.definitionId === 19)).toHaveLength(
        startTick === 38 ? 1 : 0,
      );
    },
  );

  it("makes arming audible without replaying an onset and delays the explosion until contact", () => {
    const early = arming(13).combat,
      late = arming().combat,
      released = arming(42).combat;
    expect(required(combatAudioLoops(late)[0]).rate).toBeGreaterThan(
      required(combatAudioLoops(early)[0]).rate,
    );
    expect(combatAudioCues(late, released).map((cue) => cue.kind)).toContain("eject");
    expect(combatAudioCues(late, released).map((cue) => cue.kind)).not.toContain("explosion");
    expect(combatAudioLoops(released)[0]?.id).toContain("charge:");
  });

  it("rejects corrupted public and private phase/owner/deadline metadata", () => {
    for (const mutate of [
      (s: ReturnType<typeof arming>) => {
        required(s.combat.tanks[0]).special.ownerId = 999;
      },
      (s: ReturnType<typeof arming>) => {
        required(s.combat.tanks[0]).special.commitTick = 41;
      },
      (s: ReturnType<typeof arming>) => {
        required(s.combat.tanks[0]).special.endTick = 42;
      },
      (s: ReturnType<typeof arming>) => {
        required(s.combat.players[0]).vehicleSpecialTicks = 3;
      },
    ]) {
      const state = arming(42);
      mutate(state);
      expect(() => validateCombatCheckpoint(state)).toThrow();
    }
  });

  it("roundtrips solo/four-player snapshots and archives with duplicate wire admission at every boundary", async () => {
    const proof = await tankSpecialProof();
    expect(proof.cases.map((entry) => entry.players)).toEqual([1, 4]);
    expect(proof.cases.every((entry) => entry.duplicates === entry.players * 130)).toBe(true);
    expect(canonical(recordTankCombat(12, tankDamageInput, 1).state)).toBe(canonical(arming(12)));
  });
});
