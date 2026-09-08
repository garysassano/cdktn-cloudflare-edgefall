import { describe, expect, it } from "vitest";
import { stepFirearm } from "../src/game/combat/firearm.js";
import {
  type BallisticProjectile,
  type HurtTarget,
  muzzleBlocked,
  sweepProjectile,
} from "../src/game/combat/projectile.js";
import { actionPose, stepAction } from "../src/game/combat/timeline.js";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { createCombatLab, replayCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_ATTACKS, COMBAT_CATALOG, COMBAT_SHAPES } from "../src/game/labs/combat-content.js";
import { footActor, footTerrain } from "../src/game/labs/foot-fixture.js";

const idle = {
  held: 0,
  firePressed: false,
  jumpPressed: false,
  specialPressed: false,
  interactPressed: false,
  grenadePressed: false,
};
const fire = { ...idle, held: Held.Fire, firePressed: true };
describe("firearm action ownership", () => {
  it("changes aim and crouch pose without restarting the action or duplicating its muzzle marker", () => {
    const first = stepFirearm(footActor(), fire, 1, 1, COMBAT_CATALOG);
    first.actor.locomotion = "crouched";
    const crouched = stepFirearm(first.actor, idle, 2, first.nextActionId, COMBAT_CATALOG);
    expect(crouched.actor.action).toMatchObject({
      definitionId: 13,
      stateStartTick: 1,
      actionInstanceId: 1,
      nextMarkerIndex: 2,
    });
    expect(crouched.markers).toHaveLength(0);
    crouched.actor.aim = 1;
    const up = stepFirearm(crouched.actor, idle, 3, crouched.nextActionId, COMBAT_CATALOG);
    expect(up.actor.action.definitionId).toBe(11);
    expect(up.markers.map((marker) => marker.markerIndex)).toEqual([2]);
    expect(up.actor.weapon.shotOrdinal).toBe(1);
  });
  it("merges held plus onset into one shot and preserves an entirely released tap", () => {
    for (const held of [0, Held.Fire]) {
      const result = stepFirearm(footActor(), { held, firePressed: true }, 1, 1, COMBAT_CATALOG);
      expect(result.markers.filter((item) => item.marker.kind === "spawn-attack")).toHaveLength(1);
      expect(result.actor.weapon.shotOrdinal).toBe(1);
      expect(result.nextActionId).toBe(2);
      expect(result.actor.weapon.cooldownTicks).toBe(8);
    }
  });
  it("fires at ticks 1, 6 and 11 with one ammo debit per HMG action, then falls back at tick 16", () => {
    let actor = footActor();
    actor.weapon = { ...actor.weapon, id: "heavy-machine-gun", ammo: 3 };
    let next = 1;
    const shots = [];
    for (let tick = 1; tick <= 16; tick++) {
      const result = stepFirearm(actor, fire, tick, next, COMBAT_CATALOG);
      actor = result.actor;
      next = result.nextActionId;
      if (result.outcome === "applied") shots.push([tick, actor.weapon.id, actor.weapon.ammo]);
    }
    expect(shots).toEqual([
      [1, "heavy-machine-gun", 2],
      [6, "heavy-machine-gun", 1],
      [11, "heavy-machine-gun", 0],
      [16, "sidearm", 0],
    ]);
  });
  it("acknowledges a rejected onset without deferring a shot", () => {
    let result = stepFirearm(footActor(), fire, 1, 1, COMBAT_CATALOG);
    result = stepFirearm(
      result.actor,
      { ...fire, held: 0 },
      2,
      result.nextActionId,
      COMBAT_CATALOG,
    );
    expect(result.outcome).toBe("cooldown");
    for (let tick = 3; tick < 20; tick++)
      result = stepFirearm(result.actor, idle, tick, result.nextActionId, COMBAT_CATALOG);
    expect(result.actor.weapon.shotOrdinal).toBe(1);
  });
  it.each(["hurt", "enter", "exit", "melee", "grenade"] as const)(
    "does not interrupt %s for firearm input",
    (kind) => {
      const actor = footActor();
      actor.action.kind = kind;
      expect(stepFirearm(actor, fire, 1, 1, COMBAT_CATALOG).outcome).toBe("unavailable");
    },
  );
  it("cancels remaining firearm markers on death without a new debit", () => {
    const first = stepFirearm(footActor(), fire, 1, 1, COMBAT_CATALOG);
    first.actor.life = "death";
    const dead = stepFirearm(first.actor, fire, 3, first.nextActionId, COMBAT_CATALOG);
    expect(dead.markers).toHaveLength(0);
    expect(dead.actor.weapon.shotOrdinal).toBe(1);
  });
  it("selects authored standing, up, down-air and crouched muzzle poses", () => {
    const observed = [];
    for (const [aim, crouched] of [
      [0, false],
      [1, false],
      [2, false],
      [0, true],
    ] as const) {
      const actor = footActor();
      actor.aim = aim;
      actor.locomotion = crouched ? "crouched" : "airborne";
      const result = stepFirearm(actor, fire, 1, 1, COMBAT_CATALOG);
      observed.push(result.actor.action.definitionId);
    }
    expect(observed).toEqual([10, 11, 12, 13]);
  });
  it("resumes marker cursors exactly and rejects a skipped active marker", () => {
    const first = stepFirearm(footActor(), fire, 1, 1, COMBAT_CATALOG);
    const restored = JSON.parse(JSON.stringify(first.actor.action));
    expect(stepAction(restored, 1, COMBAT_CATALOG).markers).toHaveLength(0);
    expect(stepAction(restored, 3, COMBAT_CATALOG).markers.map((m) => m.markerIndex)).toEqual([2]);
    expect(() => stepAction(restored, 4, COMBAT_CATALOG)).toThrow(/skipped/);
    expect(actionPose(COMBAT_CATALOG, 10, 4)).toBeNull();
  });
});

const bullet = (): BallisticProjectile => ({
  id: 1000,
  ownerId: 1,
  team: 1,
  actionInstanceId: 1,
  definitionId: 1,
  position: { x: 0, y: 0 },
  velocity: { x: pixels(100), y: 0 },
  spawnTick: 1,
});
const target = (id: number, x: number): HurtTarget => ({
  id,
  entityId: 20,
  team: 2,
  kind: "body",
  rect: { x: pixels(x), y: pixels(-4), w: pixels(2), h: pixels(8) },
  delta: { x: 0, y: 0 },
});
const attack = COMBAT_ATTACKS.get(1);
const shape = COMBAT_SHAPES.get(4);
if (!attack || !shape) throw new Error("Missing ballistic fixture");
describe("swept ballistic hits", () => {
  it("lets a flank hit exposed body before the shield on the opposite side", () => {
    const shot = bullet();
    shot.position.x = pixels(100);
    shot.velocity.x = -pixels(100);
    expect(
      sweepProjectile(
        shot,
        attack,
        shape,
        [],
        [target(40, 30), { ...target(41, 27), kind: "shield" }],
      ),
    ).toMatchObject({ colliderId: 40, kind: "body", damage: 1 });
  });
  it("blocks a target behind thin terrain regardless of insertion order", () => {
    const wall = footTerrain(100, 30, -10, 1, 20);
    const result = sweepProjectile(bullet(), attack, shape, [wall], [target(40, 50)]);
    expect(result).toMatchObject({ kind: "terrain", damage: 0, colliderId: 100 });
  });
  it("ties terrain before shield before body and resolves by collision ID", () => {
    const body = target(40, 30),
      shield = { ...target(41, 30), kind: "shield" as const };
    for (const hurtboxes of [
      [body, shield],
      [shield, body],
    ]) {
      expect(sweepProjectile(bullet(), attack, shape, [], hurtboxes)?.kind).toBe("shield");
      expect(
        sweepProjectile(bullet(), attack, shape, [footTerrain(100, 30, -4, 2, 8)], hurtboxes)?.kind,
      ).toBe("terrain");
    }
  });
  it("hits a target crossing the bullet path during the tick", () => {
    const crossing = {
      ...target(40, 50),
      rect: { x: pixels(50), y: pixels(-30), w: pixels(2), h: pixels(8) },
      delta: { x: 0, y: pixels(60) },
    };
    expect(sweepProjectile(bullet(), attack, shape, [], [crossing])?.entityId).toBe(20);
  });
  it("ignores owner and allies, and grants a single hit for overlapping body shapes", () => {
    const boxes = [target(40, 30), target(41, 30)];
    expect(sweepProjectile(bullet(), attack, shape, [], boxes)?.colliderId).toBe(40);
    expect(
      sweepProjectile(
        bullet(),
        attack,
        shape,
        [],
        boxes.map((t) => ({ ...t, team: 1 })),
      ),
    ).toBeNull();
    expect(
      sweepProjectile(
        bullet(),
        attack,
        shape,
        [],
        boxes.map((t) => ({ ...t, entityId: 1 })),
      ),
    ).toBeNull();
  });
  it("checks the hand-to-muzzle path even when the muzzle is beyond a wall", () => {
    expect(
      muzzleBlocked({ x: 0, y: 0 }, { x: pixels(15), y: 0 }, shape, [
        footTerrain(100, 7, -10, 1, 20),
      ]),
    ).toBe(true);
  });
});

describe("ordered controller/combat/encounter integration", () => {
  it("releases at the post-movement muzzle and advances the projectile on the following tick", () => {
    const first = stepCombatLab(createCombatLab("range"), [fire]);
    const bullet = first.projectiles[0];
    if (!bullet) throw new Error("Missing born projectile");
    expect(bullet.position).toEqual({ x: pixels(60), y: pixels(177) });
    const next = stepCombatLab(first, [idle]);
    expect(next.projectiles[0]?.position.x).toBe(pixels(72));
  });
  it("shoots while moving and jumping through the same foot controller", () => {
    const start = createCombatLab("range");
    const world = stepCombatLab(start, [
      { ...fire, held: Held.Right | Held.Fire, jumpPressed: true },
    ]);
    expect(world.players[0]?.body.x).toBeGreaterThan(start.players[0]?.body.x ?? 0);
    expect(world.players[0]?.body.y).toBeLessThan(start.players[0]?.body.y ?? 0);
    expect(world.events.some((event) => event.kind === "shot")).toBe(true);
    expect(start.tick).toBe(0);
  });
  it("resolves simultaneous four-player damage once with stable kill credit and a completed ledger", () => {
    let world = createCombatLab("range", 4);
    for (let tick = 0; tick < 90; tick++)
      world = stepCombatLab(
        world,
        Array.from({ length: 4 }, () => fire),
      );
    expect(world.targets.map((target) => target.health)).toEqual([0, 0]);
    expect(world.encounter.phase).toBe("complete");
    expect(world.encounter.kills.reduce((sum, player) => sum + player.count, 0)).toBe(2);
    expect(world.targets.every((target) => target.enemy.life === "removed")).toBe(true);
  });
  it.each(["wall", "shield"] as const)(
    "keeps the %s encounter unresolved without a real kill",
    (scenario) => {
      let world = createCombatLab(scenario);
      for (let tick = 0; tick < 90; tick++) world = stepCombatLab(world, [fire]);
      expect(world.targets[0]?.health).toBe(1);
      expect(world.encounter.phase).toBe("active");
    },
  );
  it("replays across serialized mid-action checkpoints with identical projectiles and marker cursors", () => {
    let world = createCombatLab("range", 2);
    const commands = Array.from({ length: 90 }, (_, tick) =>
      Array.from({ length: 2 }, () => (tick < 30 ? fire : idle)),
    );
    let restored = world;
    for (const [tick, input] of commands.entries()) {
      world = stepCombatLab(world, input);
      restored = stepCombatLab(restored, input);
      if (tick === 0 || tick === 13) restored = JSON.parse(JSON.stringify(restored));
      expect(restored).toEqual(world);
    }
    expect(
      replayCombatLab({
        format: 16,
        scenario: "range",
        players: 2,
        commands,
        finalState: canonical(world),
      }),
    ).toEqual(world);
  });
});
