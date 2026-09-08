import { describe, expect, it } from "vitest";
import { stepGroundedEnemy } from "../src/game/actors/grounded.js";
import {
  createShieldState,
  damageShield,
  shieldProtected,
  stepShield,
} from "../src/game/actors/shield.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { type CombatLab, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import {
  COMBAT_ATTACKS,
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  SHIELD_PROFILE,
} from "../src/game/labs/combat-content.js";
import { footActor, footTerrain } from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { recordShieldCombat, shieldCombatProof } from "./fixtures/shield-proof.js";

const idle = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  specialPressed: false,
  interactPressed: false,
  grenadePressed: false,
};
function advance(world: CombatLab, through: number, command = idle) {
  const states = [];
  while (world.tick < through) {
    world = stepCombatLab(
      world,
      world.players.map(() => command),
    );
    states.push(world);
  }
  return { world, states };
}

describe("active shield infantry", () => {
  it("commits a stable target and turns only at the authored marker while exposing its body", () => {
    const enemy = createCombatLab("guard").targets[0]?.enemy;
    if (!enemy) throw new Error("Missing guard");
    const left = footActor(100, 200),
      right = footActor(180, 200);
    left.playerId = 2;
    right.playerId = 1;
    let result = stepShield(
      createShieldState(SHIELD_PROFILE),
      enemy,
      [left, right],
      1,
      1,
      COMBAT_CATALOG,
      SHIELD_PROFILE,
    );
    expect(result.state).toMatchObject({ phase: "turn", facing: -1, turnFacing: 1, targetId: 1 });
    right.body.x = pixels(70);
    for (let tick = 2; tick <= 18; tick++) {
      enemy.facing = result.state.facing;
      result = stepShield(
        result.state,
        enemy,
        [right, left],
        tick,
        result.nextActionId,
        COMBAT_CATALOG,
        SHIELD_PROFILE,
      );
      expect(result.state.facing).toBe(tick < 10 ? -1 : 1);
      expect(result.state.targetId).toBe(1);
      expect(shieldProtected(result.state, tick, SHIELD_PROFILE)).toBe(false);
      expect(result.markers.map((item) => item.marker.kind)).toEqual(
        tick === 10 ? ["face", "sound"] : [],
      );
    }
    expect(result.nextActionId).toBe(2);
  });

  it("braces, advances on the shared floor and stops at a ledge without an untelegraphed turn", () => {
    const { states } = advance(createCombatLab("guard"), 61, { ...idle, held: Held.Down });
    expect([
      states[23]?.targets[0]?.enemy.body.x,
      states[24]?.targets[0]?.enemy.body.x,
      states[59]?.targets[0]?.enemy.body.x,
    ]).toEqual([pixels(140), pixels(139), pixels(104)]);
    expect(states[60]?.targets[0]?.guard?.phase).toBe("brace");
    let enemy = createCombatLab("guard").targets[0]?.enemy;
    const shape = COMBAT_SHAPES.get(1);
    if (!enemy || !shape) throw new Error("Missing ledge fixture");
    for (let tick = 1; tick <= 60; tick++) {
      const frame = { tick, geometryRevision: 1 };
      const result = stepGroundedEnemy(
        enemy,
        {
          speed: pixels(1),
          gravity: 55,
          terminalVelocity: pixels(12),
          turnAtBoundary: false,
          bounds: { x: 0, y: 0, w: pixels(384), h: pixels(248) },
        },
        shape,
        new CollisionIndex(new CollisionGrid([footTerrain(100, 130, 200, 190, 16)]), [], frame),
        frame,
      );
      if (result.status !== "complete") throw new Error("Ledge movement failed");
      enemy = result.enemy;
    }
    expect(enemy).toMatchObject({
      facing: -1,
      turns: 0,
      life: "alive",
      body: { grounded: true, vx: 0 },
    });
    expect(enemy.body.x).toBeGreaterThanOrEqual(pixels(135));
  });

  it("blocks frontal bullets without body damage and stays a one-hit infantry target from behind", () => {
    const fire = { ...idle, held: Held.Fire, firePressed: true };
    const frontal = advance(createCombatLab("guard"), 40, fire);
    expect(frontal.world.targets[0]).toMatchObject({ health: 1, guard: { integrity: 2 } });
    expect(
      frontal.states
        .flatMap((state) => state.events)
        .some((event) => event.impact?.kind === "shield"),
    ).toBe(true);
    const rear = createCombatLab("guard");
    const player = rear.players[0];
    if (!player) throw new Error("Missing player");
    player.body.x = pixels(160);
    player.facing = -1;
    const hit = advance(rear, 7, fire).world;
    expect(hit.targets[0]).toMatchObject({ health: 0, guard: { phase: "dead", integrity: 2 } });
  });

  it("cancels an unreleased bash on death and preserves already released same-tick trades", () => {
    const run = (fireAt: number) => {
      let world = createCombatLab("guard", 2);
      const front = world.players[0],
        rear = world.players[1];
      if (!front || !rear) throw new Error("Missing flank fixture");
      front.body.x = pixels(120);
      rear.body.x = pixels(160);
      rear.facing = -1;
      const states = [];
      for (let tick = 1; tick <= 16; tick++) {
        world = stepCombatLab(world, [
          idle,
          { ...idle, held: tick >= fireAt ? Held.Fire : 0, firePressed: tick === fireAt },
        ]);
        states.push(world);
      }
      return states;
    };
    const early = run(1);
    expect(early[5]?.targets[0]?.health).toBe(0);
    expect(
      early
        .flatMap((state) => state.events)
        .filter((event) => event.kind === "melee" && event.ownerId === 20),
    ).toEqual([]);
    const trade = run(8)[12];
    expect(trade?.events.some((event) => event.kind === "melee" && event.ownerId === 20)).toBe(
      true,
    );
    expect(trade?.targets[0]?.health).toBe(0);
    expect(trade?.players[0]).toMatchObject({ life: "death", lives: 2 });
  });

  it("uses separate material integrity, emits one break and does not spill damage into body HP", () => {
    const bullet = COMBAT_ATTACKS.get(1),
      blast = COMBAT_ATTACKS.get(5);
    if (!bullet || !blast) throw new Error("Missing attacks");
    const intact = createShieldState(SHIELD_PROFILE);
    for (const material of ["bullet", "blade"] as const)
      expect(
        damageShield(intact, { ...bullet, material }, 1, 1, COMBAT_CATALOG, SHIELD_PROFILE).state
          .integrity,
      ).toBe(2);
    const heated = damageShield(
      intact,
      { ...bullet, material: "heat" },
      1,
      1,
      COMBAT_CATALOG,
      SHIELD_PROFILE,
    );
    expect(heated).toMatchObject({ broken: false, state: { integrity: 1 } });
    const second = damageShield(
      heated.state,
      { ...bullet, material: "heat" },
      2,
      1,
      COMBAT_CATALOG,
      SHIELD_PROFILE,
    );
    expect(second).toMatchObject({
      broken: true,
      nextActionId: 2,
      state: { phase: "stunned", integrity: 0 },
    });
    expect(second.markers.map((item) => item.marker.kind)).toEqual(["sound"]);
    expect(damageShield(second.state, blast, 2, 2, COMBAT_CATALOG, SHIELD_PROFILE)).toMatchObject({
      broken: false,
      nextActionId: 2,
      markers: [],
    });
    expect(damageShield(intact, blast, 1, 1, COMBAT_CATALOG, SHIELD_PROFILE).broken).toBe(true);
  });

  it("keeps a finite bash hit ledger across ticks and jump evasion avoids the committed volume", () => {
    const hit = recordShieldCombat("bash"),
      dodge = recordShieldCombat("break");
    expect(hit.states[29]?.combat.targets[0]?.guard?.hitIds).toEqual([]);
    expect(hit.states[30]?.combat.targets[0]?.guard?.hitIds).toEqual([1, 2, 3]);
    expect(hit.states[33]?.combat.targets[0]?.guard?.hitIds).toEqual([1, 2, 3]);
    expect(hit.states[34]?.snapshot.threats.some((threat) => threat.definitionId === 6)).toBe(
      false,
    );
    expect(hit.states[34]?.combat.players.map((player) => player.lives)).toEqual([2, 2, 2, 3]);
    expect(dodge.states[35]?.combat.targets[0]?.guard?.hitIds).toEqual([]);
    expect(dodge.states[95]?.combat.players.map((player) => player.lives)).toEqual([3, 3, 3, 3]);
    expect(dodge.states[95]?.combat.targets[0]).toMatchObject({
      health: 1,
      guard: { integrity: 0, phase: "stunned" },
    });
    expect(dodge.states[130]?.combat.targets[0]?.guard?.phase).toBe("stunned");
    expect(dodge.states[131]?.combat.targets[0]?.guard?.phase).not.toBe("stunned");
  });

  it("rejects rewound turns, duplicate bash hits, unknown targets and phase policy corruption", () => {
    const fixture = recordShieldCombat("bash");
    for (const [tick, mutate] of [
      [
        57,
        (guard: NonNullable<CombatLab["targets"][number]["guard"]>) => {
          guard.action.nextMarkerIndex = 0;
        },
      ],
      [
        56,
        (guard: NonNullable<CombatLab["targets"][number]["guard"]>) => {
          guard.facing = 1;
        },
      ],
      [
        30,
        (guard: NonNullable<CombatLab["targets"][number]["guard"]>) => {
          guard.hitIds.push(1);
        },
      ],
      [
        18,
        (guard: NonNullable<CombatLab["targets"][number]["guard"]>) => {
          guard.targetId = 999;
        },
      ],
      [
        18,
        (guard: NonNullable<CombatLab["targets"][number]["guard"]>) => {
          guard.phase = "stunned";
        },
      ],
    ] as const) {
      const state = structuredClone(fixture.states[tick]);
      if (!state?.combat.targets[0]?.guard) throw new Error("Missing guard continuation");
      expect(() => validateCombatCheckpoint(state)).not.toThrow();
      mutate(state.combat.targets[0].guard);
      expect(() => validateCombatCheckpoint(state)).toThrow();
    }
  });

  it("preserves admitted turn, hit and break continuation through wire frames and journal replay", async () => {
    const proof = await shieldCombatProof();
    expect(proof.scenarios.map((scenario) => scenario.duplicates)).toEqual([720, 720]);
    expect(proof.scenarios[1]?.encounter).toBe("complete");
  });
});
