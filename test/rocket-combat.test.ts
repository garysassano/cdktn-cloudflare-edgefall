import { beforeAll, describe, expect, it } from "vitest";
import { damagePlayer } from "../src/game/campaign/life.js";
import { ROCKET_PROFILE } from "../src/game/content/weapons/rocket-launcher.js";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { type CombatCommand, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { combatPeerContext } from "../src/shared/diagnostics/combat-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import {
  ROCKET_COMBAT_BOUNDARIES,
  recordRocketCombat,
  rocketCombatProof,
} from "./fixtures/rocket-combat-proof.js";

const idle: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  specialPressed: false,
  interactPressed: false,
};
const fire = { ...idle, held: Held.Fire, firePressed: true };
let fixture: ReturnType<typeof recordRocketCombat>;
beforeAll(() => {
  fixture = recordRocketCombat();
});

describe("integrated rocket launcher", () => {
  it("applies a short airborne tap and onset plus held input once per charge despite duplicate packets", () => {
    expect(fixture.duplicates).toBe(640);
    for (const playerId of [1, 2, 3, 4]) {
      expect(
        fixture.states.flatMap((s) =>
          s.combat.events
            .filter((e) => e.kind === "shot" && e.ownerId === playerId)
            .map(() => s.combat.tick),
        ),
      ).toEqual([7, 31, 55]);
    }
    expect(
      fixture.state.combat.players.map((p) => [p.weapon.ammo, p.weapon.shotOrdinal, p.lives]),
    ).toEqual(Array(4).fill([17, 3, 3]));
    expect(fixture.state.combat.encounter.phase).toBe("complete");
    expect(fixture.state.combat.encounter.kills.reduce((sum, item) => sum + item.count, 0)).toBe(2);
    expect(fixture.state.combat.rockets).toEqual([]);
    for (const state of fixture.states) validateCombatCheckpoint(state);
  });
  it("retains guidance and public flight through formal checkpoint and journal reconstruction", async () => {
    const proof = await rocketCombatProof();
    expect(proof.checkpoints.map((c) => c.tick)).toEqual(ROCKET_COMBAT_BOUNDARIES);
    expect(proof.events.filter((e) => e.kind === "explosion").length).toBeGreaterThan(0);
    const state = fixture.states[10];
    if (!state?.combat.rockets[0]) throw new Error("Missing guided rocket");
    const rocket = state.combat.rockets[0],
      context = combatPeerContext(state.snapshot, 0);
    const snapshot = decodeSnapshot(encodeSnapshot(state.snapshot, context), context);
    expect(snapshot.projectiles.find((p) => p.id === rocket.id)).toMatchObject({
      heading: rocket.heading,
      vx: rocket.velocity.x,
      vy: rocket.velocity.y,
      shapeId: ROCKET_PROFILE.bodyShapeId,
      spawnTick: 7,
      lifetimeTicks: 90,
    });
    expect(rocket.heading).not.toBe(rocket.launchHeading);
    expect(rocket.targetId).not.toBeNull();
    expect(snapshot.projectiles.find((p) => p.id === rocket.id)).not.toHaveProperty("nextTurnTick");
  });
  it("rejects incomplete, stale, phase-shifted and duplicated private flight state", () => {
    const mutations = [
      (r: Record<string, unknown>) => {
        delete r.nextTurnTick;
      },
      (r: Record<string, unknown>) => {
        r.nextAcquireTick = 10;
      },
      (r: Record<string, unknown>) => {
        r.nextTurnTick = 12;
      },
      (r: Record<string, unknown>) => {
        r.tick = 9;
      },
      (r: Record<string, unknown>) => {
        r.speed = 999;
      },
      (r: Record<string, unknown>) => {
        r.targetId = 9999;
      },
      (r: Record<string, unknown>) => {
        r.definitionId = 5;
      },
    ];
    for (const mutate of mutations) {
      const state = structuredClone(fixture.states[10]);
      if (!state?.combat.rockets[0]) throw new Error("Missing rocket state");
      mutate(state.combat.rockets[0] as unknown as Record<string, unknown>);
      expect(() => validateCombatCheckpoint(state)).toThrow();
    }
    const state = structuredClone(fixture.states[10]);
    if (!state?.combat.rockets[0]) throw new Error("Missing rocket state");
    state.combat.rockets.push({
      ...structuredClone(state.combat.rockets[0]),
      id: state.combat.nextEntityId++,
    });
    expect(() => validateCombatCheckpoint(state)).toThrow(/duplicate rocket action/);
  });
  it("spends the last rocket once then falls back at the next accepted cadence boundary", () => {
    let world = createCombatLab("rocket");
    if (!world.players[0]) throw new Error("Missing launcher owner");
    world.players[0].weapon.ammo = 1;
    const shots: Array<[number, number | undefined]> = [];
    for (let tick = 1; tick <= 25; tick++) {
      world = stepCombatLab(world, [{ ...fire, firePressed: tick === 1 }]);
      for (const event of world.events)
        if (event.kind === "shot") shots.push([tick, event.source?.definitionId]);
    }
    expect(shots).toEqual([
      [1, 17],
      [25, 1],
    ]);
    expect(world.players[0]?.weapon).toMatchObject({ id: "sidearm", ammo: 0, shotOrdinal: 2 });
  });
  it.each([
    ["right", 0, false, 0],
    ["left", Held.Left, false, 16],
    ["up", Held.Up, false, 24],
    ["air down", Held.Down, true, 8],
    ["crouched", Held.Down, false, 0],
  ] as const)(
    "launches %s from the accepted action pose without advancing on its birth tick",
    (_name, held, jumpPressed, heading) => {
      const before = createCombatLab("rocket"),
        original = canonical(before);
      const world = stepCombatLab(before, [{ ...fire, held: held | Held.Fire, jumpPressed }]);
      const rocket = world.rockets[0],
        shot = world.events.find((e) => e.kind === "shot");
      expect(rocket).toMatchObject({
        spawnTick: 1,
        tick: 1,
        launchHeading: heading,
        speed: pixels(2),
      });
      expect(rocket?.position).toEqual(shot?.position);
      expect(world.players[0]?.weapon.ammo).toBe(19);
      expect(canonical(before)).toBe(original);
    },
  );
  it("blocks the flight body at the muzzle while spending one charge without a phantom blast", () => {
    const world = createCombatLab("wall");
    if (!world.players[0]) throw new Error("Missing owner");
    world.players[0].body.x = pixels(125);
    world.players[0].weapon.id = "rocket-launcher";
    world.players[0].weapon.ammo = 20;
    const next = stepCombatLab(world, [fire]);
    expect(next.rockets).toEqual([]);
    expect(next.events.filter((e) => e.kind === "muzzle-blocked")).toHaveLength(1);
    expect(next.events.some((e) => e.kind === "explosion")).toBe(false);
    expect(next.players[0]?.weapon.ammo).toBe(19);
  });
  it("continues released flight after the firing owner dies", () => {
    let world = stepCombatLab(createCombatLab("rocket"), [fire]);
    const owner = world.players[0];
    if (!owner || !world.rockets[0]) throw new Error("Missing released rocket");
    const action = world.rockets[0].actionInstanceId;
    world.players[0] = damagePlayer(owner, world.tick, 1, "classic").actor;
    world = stepCombatLab(world, [idle]);
    expect(world.rockets[0]).toMatchObject({
      actionInstanceId: action,
      ownerId: owner.playerId,
      tick: 2,
    });
    expect(world.players[0]?.life).toBe("death");
  });
});
