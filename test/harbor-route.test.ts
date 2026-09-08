import { describe, expect, it } from "vitest";
import { stateHash } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { COMBAT_STAGE_LIMIT, advanceCombatLab } from "../src/game/labs/combat.js";
import { HARBOR, harborDepot, harborStage } from "../src/game/missions/harbor-content.js";
import {
  HARBOR_ROUTE_MODES,
  harborRouteInitial,
  recordHarborRoute,
} from "./fixtures/harbor-route-proof.js";

const idle = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  interactPressed: false,
  specialPressed: false,
};

describe("Harbor physical route and shared depot", () => {
  for (const mode of HARBOR_ROUTE_MODES)
    it.each([1, 2, 4])(
      `traverses ${mode} with %i players using only input intent`,
      { timeout: 30_000 },
      (players) => {
        const proof = recordHarborRoute(mode, players);
        expect(proof.lives).toEqual(Array.from({ length: players }, () => 3));
        expect(proof.continuations.some((boundary) => boundary.tick === 3600)).toBe(true);
        if (mode === "tank") {
          expect(proof.entered).toHaveLength(players);
          expect(proof.fired).toHaveLength(players);
          expect(proof.armor).toEqual(Array.from({ length: players }, () => 3));
        } else if (mode === "spent-tanks")
          expect(proof.armor).toEqual(Array.from({ length: players }, () => 0));
      },
    );

  it.each([1, 2, 3, 4])("creates exactly %i independent finite hulls", (players) => {
    const tanks = harborDepot(players);
    expect(tanks).toHaveLength(players);
    expect(new Set(tanks.map((tank) => tank.body.id)).size).toBe(players);
    expect(
      tanks.every(
        (tank) => tank.armor === 3 && tank.secondary.ammo === 10 && tank.occupantId === null,
      ),
    ).toBe(true);
    const first = tanks[0];
    if (!first) throw new Error("Missing tank");
    first.armor = 0;
    expect(harborDepot(players).every((tank) => tank.armor === 3)).toBe(true);
    expect(tanks.slice(1).every((tank) => tank.armor === 3)).toBe(true);
  });

  it("settles a simultaneous shared hull claim without duplicating its seat", () => {
    let world = harborRouteInitial(4);
    for (const player of world.players) {
      player.body.x = pixels(HARBOR.depot.firstX - 24);
      player.body.y = pixels(HARBOR.depot.y);
      player.body.supportId = HARBOR.depot.supportId;
    }
    world = advanceCombatLab(
      world,
      world.players.map(() => ({ ...idle, interactPressed: true })),
      undefined,
      harborStage(3),
    ).state;
    expect(world.players.map((player) => player.vehicleId)).toEqual([
      HARBOR.depot.firstId,
      null,
      null,
      null,
    ]);
    expect(world.tanks.filter((tank) => tank.lifecycle === "boarding")).toHaveLength(1);
    expect(world.tanks.filter((tank) => tank.lifecycle === "available")).toHaveLength(3);
  });

  it.each(HARBOR.checkpoints.map((_, index) => index))(
    "gives all four players a supported safe checkpoint %i",
    (checkpoint) => {
      let world = harborRouteInitial(4);
      const entry = HARBOR.checkpoints[checkpoint];
      if (!entry) throw new Error("Missing checkpoint");
      for (const player of world.players) {
        player.body.x = pixels(entry.x + player.slot * 24);
        player.body.y = pixels(entry.y);
        player.body.supportId = entry.supportId;
      }
      const stage = harborStage(checkpoint);
      for (let tick = 0; tick < 6; tick++)
        world = advanceCombatLab(
          world,
          world.players.map(() => idle),
          undefined,
          stage,
        ).state;
      expect(
        world.players.every(
          (player) =>
            player.body.grounded &&
            player.body.y === pixels(entry.y) &&
            player.body.supportId === entry.supportId &&
            player.lives === 3,
        ),
      ).toBe(true);
    },
  );

  it("requires an explicit bounded stage to continue past the diagnostic recording limit", () => {
    const world = harborRouteInitial(1);
    world.tick = world.pickups.tick = world.encounter.tick = 3600;
    const hash = stateHash(world);
    expect(() => advanceCombatLab(world, [idle])).toThrow("combat tick");
    expect(advanceCombatLab(world, [idle], undefined, harborStage(0)).state.tick).toBe(3601);
    for (const tickLimit of [0, NaN, COMBAT_STAGE_LIMIT + 1])
      expect(() =>
        advanceCombatLab(world, [idle], undefined, { ...harborStage(0), tickLimit }),
      ).toThrow("combat tick limit");
    expect(stateHash(world)).toBe(hash);
    world.tick = world.pickups.tick = world.encounter.tick = HARBOR.maxTicks;
    expect(() => advanceCombatLab(world, [idle], undefined, harborStage(0))).toThrow("combat tick");
  });

  it("rejects absent party slots and unknown checkpoints", () => {
    for (const count of [0, 5, 1.5])
      expect(() => harborDepot(count)).toThrow("Harbor depot party size");
    for (const checkpoint of [-1, HARBOR.checkpoints.length, 1.5])
      expect(() => harborStage(checkpoint)).toThrow("Harbor checkpoint");
  });
});
