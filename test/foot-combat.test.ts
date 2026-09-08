import { describe, expect, it } from "vitest";
import type { HurtTarget } from "../src/game/combat/projectile.js";
import { explosionHits, meleeHits } from "../src/game/combat/volume.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import {
  type CombatCommand,
  type CombatLab,
  advanceCombatLab,
  createCombatLab,
  stepCombatLab,
} from "../src/game/labs/combat.js";
import { COMBAT_ATTACKS, COMBAT_SHAPES } from "../src/game/labs/combat-content.js";
import { footTerrain } from "../src/game/labs/foot-fixture.js";
import { encodeCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";
import { footCombatProof, recordFootCombat } from "./fixtures/foot-combat-proof.js";

const idle: CombatCommand = {
  held: 0,
  firePressed: false,
  jumpPressed: false,
  specialPressed: false,
  interactPressed: false,
  grenadePressed: false,
};
const fire = { ...idle, held: Held.Fire, firePressed: true };
const throwing = { ...idle, specialPressed: false, interactPressed: false, grenadePressed: true };
function advance(
  initial: CombatLab,
  through: number,
  command: (tick: number) => CombatCommand = () => idle,
) {
  let world = initial;
  const states = [];
  while (world.tick < through) {
    world = stepCombatLab(
      world,
      world.players.map(() => command(world.tick + 1)),
    );
    states.push(world);
  }
  return { world, states };
}
const source = { id: 1000, ownerId: 1, team: 1, actionInstanceId: 1, definitionId: 4 };
const hurt = (x: number, width = 2): HurtTarget => ({
  id: 40,
  entityId: 20,
  team: 2,
  kind: "body",
  rect: { x: pixels(x), y: pixels(-4), w: pixels(width), h: pixels(8) },
  delta: { x: 0, y: 0 },
});

describe("contextual knife and discrete grenade authority", () => {
  it("reaches overlapping infantry in front of the player and cannot raycast from beyond thin cover", () => {
    const world = createCombatLab("range");
    if (!world.targets[0]) throw new Error("Missing close infantry");
    world.targets[0].enemy.body.x = pixels(50);
    expect(stepCombatLab(world, [fire]).players[0]?.action.kind).toBe("melee");
    const definition = COMBAT_ATTACKS.get(4),
      shape = COMBAT_SHAPES.get(9);
    if (!definition || !shape) throw new Error("Missing knife content");
    const query = (terrain: ReturnType<typeof footTerrain>[]) =>
      meleeHits(
        source,
        definition,
        shape,
        { x: pixels(10), y: 0 },
        { x: 0, y: 0 },
        1,
        { x: 0, y: 0 },
        terrain,
        [hurt(11)],
      );
    expect(query([]).map((hit) => hit.entityId)).toEqual([20]);
    expect(query([footTerrain(100, 8, -10, 1, 20)])).toEqual([]);
  });

  it("replays admitted retransmissions across private action, active-hit and fuse boundaries", async () => {
    const proof = await footCombatProof();
    expect(proof.scenarios.map((scenario) => scenario.duplicates)).toEqual([480, 480, 480]);
    const active = proof.scenarios[0]?.checkpoints.find((checkpoint) => checkpoint.tick === 51);
    expect(active?.hitIds).toEqual([[20], [20], [20], [20]]);
    expect(proof.scenarios[1]?.actions.filter((event) => event.kind === "killed")).toHaveLength(2);
  });

  it("rejects impossible private hit histories and bounce counts before checkpointing", async () => {
    const identity = await combatArchiveIdentity();
    const melee = recordFootCombat("melee").states[51],
      grenade = recordFootCombat("grenade").states[52];
    if (!melee?.combat.strikes[0] || !grenade?.combat.grenades[0])
      throw new Error("Missing live foot action");
    melee.combat.strikes[0].hitIds.push(20);
    grenade.combat.grenades[0].bounces = 4;
    await expect(encodeCombatCheckpoint(melee, identity)).rejects.toThrow();
    await expect(encodeCombatCheckpoint(grenade, identity)).rejects.toThrow();
  });

  it("bounds volume coordinates and rejects ambiguous collision identities", () => {
    const definition = COMBAT_ATTACKS.get(5);
    if (!definition) throw new Error("Missing blast content");
    const query = (x: number, targets: HurtTarget[]) =>
      explosionHits(
        { ...source, definitionId: 5 },
        definition,
        { x, y: 0 },
        pixels(48),
        [],
        targets,
      );
    expect(() => query(Number.MAX_SAFE_INTEGER, [])).toThrow(/position/);
    expect(() => query(0, [{ ...hurt(40), rect: { ...hurt(40).rect, x: NaN } }])).toThrow(
      /position/,
    );
    expect(() => query(0, [hurt(40), hurt(40)])).toThrow(/Duplicate/);
  });

  it("chooses eligible close infantry without spending gun ammo and releases the authored active window", () => {
    const start = createCombatLab("range"),
      player = start.players[0],
      target = start.targets[0];
    if (!player || !target) throw new Error("Missing combat fixture");
    player.weapon.id = "heavy-machine-gun";
    player.weapon.ammo = 12;
    target.enemy.body.x = pixels(70);
    const { states, world } = advance(start, 19, () => fire);
    expect(states[0]?.players[0]?.action).toMatchObject({ kind: "melee", stateStartTick: 1 });
    expect(states.slice(0, 5).every((state) => state.targets[0]?.health === 1)).toBe(true);
    expect(
      states[5]?.events.filter((event) => event.kind === "killed").map((event) => event.targetId),
    ).toEqual([20]);
    expect(states[5]?.strikes[0]?.hitIds).toEqual([20]);
    expect(states[8]?.strikes[0]?.endTick).toBe(10);
    expect(states[9]?.strikes).toEqual([]);
    expect(states[17]?.players[0]?.weapon).toMatchObject({ ammo: 12, shotOrdinal: 0 });
    expect(world.players[0]?.weapon).toMatchObject({ ammo: 11, shotOrdinal: 1 });
  });

  it("does not select knife through concrete, behind the player, or through a facing shield", () => {
    for (const scenario of ["wall", "shield", "range"] as const) {
      const world = createCombatLab(scenario),
        player = world.players[0],
        target = world.targets[0];
      if (!player || !target) throw new Error("Missing combat fixture");
      player.body.x = pixels(scenario === "wall" ? 125 : 45);
      target.enemy.body.x = pixels(scenario === "wall" ? 151 : scenario === "shield" ? 70 : 25);
      const result = stepCombatLab(world, [fire]);
      expect(result.players[0]?.action.kind).toBe("fire");
      expect(result.strikes).toEqual([]);
    }
    const behind = createCombatLab("shield"),
      player = behind.players[0];
    if (!player) throw new Error("Missing player");
    player.body.x = pixels(240);
    player.facing = -1;
    const result = advance(behind, 6, () => fire);
    expect(result.states[0]?.players[0]?.action.kind).toBe("melee");
    expect(result.world.targets[0]?.health).toBe(0);
  });

  it("sweeps fast hurtboxes, deduplicates a target's shapes and preserves a per-window hit budget", () => {
    const definition = COMBAT_ATTACKS.get(4),
      shape = COMBAT_SHAPES.get(9);
    if (!definition || !shape) throw new Error("Missing knife content");
    const moving = hurt(100);
    moving.delta.x = -pixels(100);
    const query = (terrain: ReturnType<typeof footTerrain>[] = [], hitIds: number[] = []) =>
      meleeHits(
        source,
        definition,
        shape,
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        1,
        { x: 0, y: 0 },
        terrain,
        [moving, { ...moving, id: 41 }],
        hitIds,
      );
    expect(query().map((hit) => hit.entityId)).toEqual([20]);
    expect(query([], [20])).toEqual([]);
    expect(query([footTerrain(100, 20, -10, 1, 20)])).toEqual([]);
  });

  it("tests nearest hurtbox distance, circle corners, cover and shield direction for blasts", () => {
    const definition = COMBAT_ATTACKS.get(5);
    if (!definition) throw new Error("Missing blast content");
    const query = (targets: HurtTarget[], terrain: ReturnType<typeof footTerrain>[] = []) =>
      explosionHits(
        { ...source, definitionId: 5 },
        definition,
        { x: 0, y: 0 },
        pixels(48),
        terrain,
        targets,
      );
    expect(query([hurt(45, 100)]).map((hit) => hit.entityId)).toEqual([20]);
    expect(query([{ ...hurt(47), rect: { ...hurt(47).rect, y: pixels(20) } }])).toEqual([]);
    expect(query([hurt(45)], [footTerrain(100, 20, -10, 1, 20)])).toEqual([]);
    const shield = { ...hurt(40), id: 41, kind: "shield" as const };
    expect(query([hurt(45), shield]).map((hit) => [hit.kind, hit.damage])).toEqual([["shield", 0]]);
    expect(query([hurt(30), shield]).map((hit) => [hit.kind, hit.damage])).toEqual([["body", 1]]);
  });

  it("arbitrates simultaneous fire/grenade intent once, releases at the hand and detonates after 90 flight ticks", () => {
    const start = advanceCombatLab(createCombatLab("range"), [
      { ...fire, specialPressed: false, interactPressed: false, grenadePressed: true },
    ]);
    expect(start.outcomes[0]).toMatchObject({ grenade: "applied", fire: "cooldown" });
    expect(start.state.players[0]?.grenadeStock).toBe(9);
    expect(start.state.players[0]?.weapon.shotOrdinal).toBe(0);
    const { states, world } = advance(start.state, 100);
    expect(
      states
        .filter((state) => state.events.some((event) => event.kind === "throw"))
        .map((state) => state.tick),
    ).toEqual([5]);
    expect(
      states
        .filter((state) => state.events.some((event) => event.kind === "explosion"))
        .map((state) => state.tick),
    ).toEqual([95]);
    expect(
      states
        .flatMap((state) => state.grenades)
        .every((grenade) => grenade.bounces <= 3 && grenade.body.y + pixels(3) <= pixels(200)),
    ).toBe(true);
    expect(world.grenades).toEqual([]);
    expect(world.players[0]?.grenadeStock).toBe(9);
    expect(world.targets.some((target) => target.health === 0)).toBe(true);
  });

  it("uses a low crouched throw and keeps a thin wall ahead of the release and all later flight", () => {
    const wall = createCombatLab("wall"),
      player = wall.players[0];
    if (!player) throw new Error("Missing player");
    player.body.x = pixels(132);
    const result = advance(wall, 95, (tick) => ({
      ...idle,
      held: Held.Down,
      specialPressed: false,
      interactPressed: false,
      grenadePressed: tick === 1,
    }));
    const released = result.states[4]?.grenades[0];
    expect(released?.body.y).toBe(pixels(188));
    expect(
      result.states
        .flatMap((state) => state.grenades)
        .every((grenade) => grenade.body.x + pixels(3) <= pixels(140)),
    ).toBe(true);
    expect(result.world.targets.every((target) => target.health === 1)).toBe(true);
  });

  it("cancels a throw when killed before release while a released grenade survives its owner's death", () => {
    const cancelled = advance(createCombatLab("rifle"), 100, (tick) => ({
      ...idle,
      specialPressed: false,
      interactPressed: false,
      grenadePressed: tick === 75,
    }));
    expect(cancelled.states.some((state) => state.players[0]?.life === "death")).toBe(true);
    expect(
      cancelled.states.flatMap((state) => state.events).some((event) => event.kind === "throw"),
    ).toBe(false);
    const released = advance(createCombatLab("rifle"), 100, (tick) =>
      tick === 1 ? throwing : idle,
    );
    expect(
      released.states.some(
        (state) => state.players[0]?.life === "death" && state.grenades.length === 1,
      ),
    ).toBe(true);
    expect(
      released.states
        .filter((state) => state.events.some((event) => event.kind === "explosion"))
        .map((state) => state.tick),
    ).toEqual([95]);
  });
});
