import { describe, expect, it } from "vitest";
import { createRifleState, rifleMode, stepRifleAttack } from "../src/game/actors/rifle.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { type CombatLab, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_CATALOG, COMBAT_SHAPES, RIFLE_PROFILE } from "../src/game/labs/combat-content.js";
import { footActor, footTerrain } from "../src/game/labs/foot-fixture.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { createCombatRuntime } from "../src/shared/diagnostics/combat-runtime.js";
import { recordCombatInputs } from "./fixtures/combat-input-driver.js";
import { rifleRecoveryProof } from "./fixtures/rifle-proof.js";

const idle = { held: 0, jumpPressed: false, firePressed: false };
const crouch = { ...idle, held: Held.Down };
const fire = { ...idle, held: Held.Fire, firePressed: true };
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
const shots = (world: CombatLab, owner = 20) =>
  world.events.filter((event) => event.kind === "shot" && event.ownerId === owner);

describe("grounded rifleman commitment and counterplay", () => {
  it("raises for 24 ticks, releases a finite burst, and recovers before acquiring again", () => {
    const { states } = advance(createCombatLab("rifle"), 110, crouch);
    expect(states.filter((world) => shots(world).length).map((world) => world.tick)).toEqual([
      25, 31, 37, 98, 104, 110,
    ]);
    const modes = [1, 24, 25, 37, 38, 72, 73, 74].map((tick) => {
      const rifle = states[tick - 1]?.targets[0]?.rifle;
      if (!rifle) throw new Error("Missing rifle");
      return rifleMode(rifle, tick, RIFLE_PROFILE);
    });
    expect(modes).toEqual([1, 1, 2, 2, 3, 3, 0, 1]);
    expect(new Set(states.slice(0, 72).map((world) => world.targets[0]?.enemy.body.x)).size).toBe(
      1,
    );
    expect(states.every((world) => world.players[0]?.life === "alive")).toBe(true);
    expect(states.at(-1)?.targets.map((target) => target.health)).toEqual([1, 1]);
  });

  it("uses stable target ties and retains its level aim and facing after the target crosses", () => {
    const enemy = createCombatLab("rifle").targets[0]?.enemy;
    const bullet = COMBAT_SHAPES.get(4);
    if (!enemy || !bullet) throw new Error("Missing rifle fixture");
    const left = footActor(180, 200),
      right = footActor(260, 200);
    left.playerId = 2;
    right.playerId = 1;
    let result = stepRifleAttack(
      createRifleState(),
      enemy,
      [left, right],
      1,
      1,
      COMBAT_CATALOG,
      RIFLE_PROFILE,
      bullet,
      [],
    );
    expect(result.state).toMatchObject({ targetId: 1, aim: 0 });
    expect(result.facing).toBe(1);
    right.body.x = pixels(100);
    right.body.y = pixels(100);
    for (let tick = 2; tick <= 25; tick++)
      result = stepRifleAttack(
        result.state,
        { ...enemy, facing: -1 },
        [right, left],
        tick,
        result.nextActionId,
        COMBAT_CATALOG,
        RIFLE_PROFILE,
        bullet,
        [],
      );
    expect(result.state).toMatchObject({ targetId: 1, aim: 0 });
    expect(result.facing).toBe(1);
    expect(result.markers.filter((marker) => marker.marker.kind === "spawn-attack")).toHaveLength(
      1,
    );
    expect(result.nextActionId).toBe(2);
  });

  it("uses the authored up lane and refuses to acquire through terrain", () => {
    const enemy = createCombatLab("rifle").targets[0]?.enemy;
    const bullet = COMBAT_SHAPES.get(4);
    if (!enemy || !bullet) throw new Error("Missing rifle fixture");
    const high = footActor(220, 100);
    const step = (players = [high], terrain: ReturnType<typeof footTerrain>[] = []) =>
      stepRifleAttack(
        createRifleState(),
        enemy,
        players,
        1,
        1,
        COMBAT_CATALOG,
        RIFLE_PROFILE,
        bullet,
        terrain,
      );
    expect(step().state).toMatchObject({ aim: 1, action: { definitionId: 31 } });
    expect(step([high], [footTerrain(101, 180, 140, 80, 4)]).state.action.kind).toBe("ready");
    expect(step([footActor(45, 200)], [footTerrain(101, 140, 130, 4, 70)]).state.action.kind).toBe(
      "ready",
    );
    enemy.body.grounded = false;
    expect(step().state.action.kind).toBe("ready");
  });

  it("kills a standing player once, preserves enemy accounting, and permits protected entry", () => {
    const { states, world } = advance(createCombatLab("rifle"), 180);
    const deaths = states.flatMap((world) =>
      world.events
        .filter((event) => event.kind === "killed" && event.targetId === 1)
        .map(() => world.tick),
    );
    expect(deaths).toEqual([77]);
    expect(world.players[0]).toMatchObject({ life: "alive", lives: 2 });
    expect(world.players[0]?.invulnerableTicks).toBeGreaterThan(0);
    expect(world.encounter.kills.every((credit) => credit.count === 0)).toBe(true);
    expect(world.targets.every((target) => target.health === 1)).toBe(true);
    expect(states[106]?.players[0]?.life).toBe("respawning");
    expect(states[118]?.players[0]?.life).toBe("alive");
  });

  it("cancels unreleased markers on death while already released bullets remain independent", () => {
    const early = advance(createCombatLab("rifle"), 50, fire);
    expect(early.world.targets.every((target) => target.health === 0)).toBe(true);
    expect(early.states.flatMap((world) => shots(world))).toHaveLength(0);
    const raised = advance(createCombatLab("rifle"), 25).world;
    const later = advance(raised, 90, fire);
    const death = later.states.find((world) =>
      world.events.some((event) => event.kind === "killed" && event.targetId === 20),
    );
    expect(death?.projectiles.some((projectile) => projectile.ownerId === 20)).toBe(true);
    expect(
      later.states
        .filter((world) => world.tick > (death?.tick ?? 0))
        .flatMap((world) => shots(world)),
    ).toHaveLength(0);
    expect(later.world.encounter.kills.reduce((total, credit) => total + credit.count, 0)).toBe(2);
    expect(later.world.players[0]?.lives).toBe(2);
  });
  it("spends one life when two hostile bullets arrive at the same tick", () => {
    const world = advance(createCombatLab("rifle"), 25).world;
    expect(world.projectiles).toHaveLength(2);
    for (const projectile of world.projectiles)
      projectile.position = { x: pixels(51), y: pixels(177) };
    const hit = stepCombatLab(world, [idle]);
    expect(
      hit.events.filter((event) => event.kind === "impact" && event.targetId === 1),
    ).toHaveLength(2);
    expect(
      hit.events.filter((event) => event.kind === "killed" && event.targetId === 1),
    ).toHaveLength(1);
    expect(hit.players[0]).toMatchObject({ life: "death", lives: 2 });
  });

  it("rejects rewound releases, changed targets, invalid origins and shared action ownership on restore", () => {
    const captured = recordCombatInputs(createCombatRuntime("rifle"), 25, 0).state;
    expect(() => validateCombatCheckpoint(captured)).not.toThrow();
    const mutations = [
      (state: typeof captured) => {
        if (state.combat.targets[0]?.rifle)
          state.combat.targets[0].rifle.action.nextMarkerIndex = 0;
      },
      (state: typeof captured) => {
        if (state.combat.targets[0]?.rifle) state.combat.targets[0].rifle.targetId = 99;
      },
      (state: typeof captured) => {
        if (state.combat.targets[0]?.rifle) state.combat.targets[0].rifle.facing = 1;
      },
      (state: typeof captured) => {
        if (state.combat.targets[0]?.rifle && state.combat.targets[1]?.rifle)
          state.combat.targets[1].rifle.action.actionInstanceId =
            state.combat.targets[0].rifle.action.actionInstanceId;
      },
      (state: typeof captured) => {
        if (state.combat.events[0]) state.combat.events[0].markerIndex = 2;
      },
      (state: typeof captured) => {
        if (state.history.entries[0]) state.history.entries[0].event.origin = "player";
      },
      (state: typeof captured) => {
        const event = state.history.entries[0]?.event;
        if (event) {
          event.origin = "player";
          event.confirmation = { playerId: event.ownerId, controlEpoch: 1, shotOrdinal: 1 };
        }
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(captured);
      mutate(changed);
      expect(() => validateCombatCheckpoint(changed)).toThrow();
    }
  });

  it("reconciles real hostile impacts in four admitted input streams without player shot confirmations", () => {
    const recording = recordCombatInputs(createCombatRuntime("rifle"), 180, 0);
    expect(recording.state.combat.players.some((player) => player.lives < 3)).toBe(true);
    const events = recording.states.flatMap((state) =>
      state.history.entries.filter((entry) => entry.tick === state.combat.tick),
    );
    expect(events.some(({ event }) => event.kind === "killed" && event.origin === "enemy")).toBe(
      true,
    );
    expect(
      events.every(({ event }) => event.origin === "enemy" && event.confirmation === null),
    ).toBe(true);
    expect(recording.states[12]?.snapshot.threats).toHaveLength(2);
    expect(recording.states[38]?.snapshot.threats).toHaveLength(0);
    expect(recording.reconciliations).toBe(60);
  });
  it("restores a partial burst and real player damage from committed inputs", async () => {
    const proof = await rifleRecoveryProof();
    expect(proof.remainingFirstBurst).toEqual([31, 37]);
    expect(proof.firstBurst).toEqual([25, 31, 37]);
    expect(proof.checkpoints.map((checkpoint) => checkpoint.tick)).toContain(28);
  });
});
