import { describe, expect, it } from "vitest";
import { stepCannonShell } from "../src/game/combat/cannon.js";
import type { BallisticProjectile, HurtTarget } from "../src/game/combat/projectile.js";
import {
  CANNON_ATTACK,
  CANNON_PROFILE,
  CANNON_SHAPE,
} from "../src/game/content/weapons/tank-cannon.js";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Edge, Held } from "../src/game/input/types.js";
import { stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_CATALOG, COMBAT_SHAPES, TANK_PROFILE } from "../src/game/labs/combat-content.js";
import { footTerrain } from "../src/game/labs/foot-fixture.js";
import { stepTankCannon, stepTankGun, validateTankProfile } from "../src/game/vehicles/tank.js";
import { tankCannonPose } from "../src/shared/animation/tank-cannon.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { transitionCombatRuntime } from "../src/shared/diagnostics/combat-recovery.js";
import {
  type CombatRuntime,
  stageCombatRuntime,
} from "../src/shared/diagnostics/combat-runtime.js";
import {
  CANNON_BOUNDARIES,
  cannonCombatProof,
  recordCannonCombat,
} from "./fixtures/cannon-proof.js";
import { recordTankCombat, tankDamageInput } from "./fixtures/tank-proof.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing cannon fixture");
  return value;
}
const occupied = () => required(recordTankCombat(12, tankDamageInput, 1).state.combat.tanks[0]);
const shell = (heading = 0): BallisticProjectile => ({
  id: 1000,
  ownerId: 1,
  team: 1,
  actionInstanceId: 5,
  definitionId: CANNON_ATTACK.id,
  position: { x: 0, y: 0 },
  velocity: required(CANNON_PROFILE.headings[heading]).velocity,
  spawnTick: 1,
});
const body = (id: number, x: number, y = 0): HurtTarget => ({
  id: id * 10,
  entityId: id,
  team: 2,
  kind: "body",
  rect: { x: pixels(x - 4), y: pixels(y - 6), w: pixels(8), h: pixels(12) },
  delta: { x: 0, y: 0 },
});
const flight = (
  current: BallisticProjectile,
  tick: number,
  targets: HurtTarget[] = [],
  walls = [footTerrain(900, 500, -100, 1, 200)],
) =>
  stepCannonShell(
    current,
    tick,
    CANNON_ATTACK,
    CANNON_SHAPE,
    CANNON_PROFILE.blastRadius,
    walls,
    targets,
  );

describe("finite tank cannon", () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "locks heading %i through its release and recoil without blocking the primary feed",
    (heading) => {
      const tank = occupied();
      tank.heading = heading;
      const primary = stepTankGun(
        tank,
        { held: Held.Fire, firePressed: true },
        13,
        2,
        TANK_PROFILE,
        COMBAT_CATALOG,
      );
      let result = stepTankCannon(
        tank,
        true,
        13,
        primary.nextActionId,
        TANK_PROFILE,
        COMBAT_CATALOG,
      );
      expect(primary.outcome).toBe("applied");
      expect(result.outcome).toBe("applied");
      expect(result.markers).toEqual([]);
      expect(tank.secondary.ammo).toBe(9);
      expect([tank.weapon.shotOrdinal, tank.secondary.shotOrdinal]).toEqual([1, 2]);
      tank.heading = (heading + 4) % 8;
      const markers = [];
      for (let tick = 14; tick <= 25; tick++) {
        tank.secondary.cooldownTicks--;
        result = stepTankCannon(
          tank,
          false,
          tick,
          result.nextActionId,
          TANK_PROFILE,
          COMBAT_CATALOG,
        );
        markers.push(...result.markers);
        if (tick === 16) {
          const pose = tankCannonPose(tank, tick, CANNON_PROFILE);
          expect(pose.heading).toBe(heading);
          expect(pose.recoil).toBe(0);
          expect(pose.muzzle).toEqual({
            x: tank.body.x + required(CANNON_PROFILE.headings[heading]).muzzle.x,
            y: tank.body.y + required(CANNON_PROFILE.headings[heading]).muzzle.y,
          });
        }
        if (tick === 18) expect(tankCannonPose(tank, tick, CANNON_PROFILE).recoil).toBe(pixels(4));
      }
      expect(markers.map((m) => [m.marker.tickOffset, m.marker.kind])).toEqual([
        [3, "spawn-attack"],
        [3, "sound"],
      ]);
      expect(tank.secondary.action.kind).toBe("ready");
      const before = shell(heading),
        after = flight(before, 2, [], []);
      expect(after.status).toBe("active");
      if (after.status === "active") expect(after.shell.position).toEqual(before.velocity);
      expect(before.position).toEqual({ x: 0, y: 0 });
    },
  );

  it("spends exactly ten shells and rejects cooldown and empty requests without allocations", () => {
    const tank = occupied();
    let next = 2,
      shots = 0;
    for (let tick = 13; tick <= 464; tick++) {
      tank.secondary.cooldownTicks = Math.max(0, tank.secondary.cooldownTicks - 1);
      const before = next,
        request = (tick - 13) % 45 === 0 || tick === 14;
      const result = stepTankCannon(tank, request, tick, next, TANK_PROFILE, COMBAT_CATALOG);
      next = result.nextActionId;
      shots += result.markers.filter((m) => m.marker.kind === "spawn-attack").length;
      if (tick === 14) {
        expect(result.outcome).toBe("cooldown");
        expect(next).toBe(before);
      }
      if (tick === 463) {
        expect(result.outcome).toBe("unavailable");
        expect(next).toBe(before);
      }
    }
    expect(shots).toBe(10);
    expect(tank.secondary).toMatchObject({ ammo: 0, shotsFired: 10, shotOrdinal: 10 });
  });

  it("grants one blast budget per entity at swept contact, including the direct target", () => {
    const targets = [
      body(20, 16),
      body(21, 35),
      { ...body(20, 16), id: 201 },
      { ...body(2, 10), team: 1 },
      body(1, 10),
    ];
    const result = flight(shell(), 2, targets, []);
    expect(result.status).toBe("detonated");
    expect(flight(shell(), 2, [...targets].reverse(), [])).toEqual(result);
    if (result.status !== "detonated") throw new Error("Missing blast");
    expect(result.contact.damage).toBe(0);
    expect(result.impacts.map((impact) => [impact.entityId, impact.damage])).toEqual([
      [20, 6],
      [21, 6],
    ]);
  });

  it("stops at concrete and a moving wall, occludes the far side and preserves physical shell contact with open grating", () => {
    const wall = footTerrain(900, 10, -100, 1, 200);
    const hit = flight(shell(), 2, [body(20, -10), body(21, 25)], [wall]);
    expect(hit.status).toBe("detonated");
    if (hit.status === "detonated") expect(hit.impacts.map((i) => i.entityId)).toEqual([20]);
    const moving = flight(
      shell(),
      2,
      [],
      [{ ...wall, rect: { ...wall.rect, x: pixels(20) }, delta: { x: pixels(-12), y: 0 } }],
    );
    expect(moving.status).toBe("detonated");
    const grate = stepCannonShell(
      shell(),
      2,
      CANNON_ATTACK,
      CANNON_SHAPE,
      CANNON_PROFILE.blastRadius,
      [{ ...wall, materialId: "open-grating" }],
      [body(21, 25)],
    );
    expect(grate.status).toBe("detonated");
    if (grate.status === "detonated") expect(grate.impacts.map((i) => i.entityId)).toEqual([21]);
  });

  it("expires at the exact flight boundary without creating a remote blast", () => {
    let current = shell();
    for (let age = 1; age <= 90; age++) {
      const result = flight(current, 1 + age, [], []);
      if (age === 90) expect(result.status).toBe("expired");
      else {
        if (result.status !== "active") throw new Error("Early shell expiry");
        current = result.shell;
      }
    }
    expect(() => flight(current, 92, [], [])).toThrow("cannon flight age");
  });

  it("resolves one accepted Grenade edge once even when its packet is retransmitted", () => {
    const run = recordTankCombat(23, (tick) => ({
      held: 0,
      edges: tick === 1 ? [Edge.Interact] : tick === 18 ? [Edge.Grenade] : [],
    }));
    expect(run.duplicates).toBe(92);
    expect(run.state.combat.tanks.every((tank) => tank.secondary.ammo === 9)).toBe(true);
    expect(
      run.states.flatMap((s) =>
        s.combat.events.filter(
          (e) => e.kind === "shot" && e.source?.definitionId === CANNON_ATTACK.id,
        ),
      ),
    ).toHaveLength(4);
    expect(run.state.combat.players.map((p) => p.grenadeStock)).toEqual(
      run.states[0]?.combat.players.map((p) => p.grenadeStock),
    );
  });

  it("cancels an unreleased shell at pause and retains a released shell across recovery", () => {
    const run = recordCannonCombat();
    for (const tick of [20, 21]) {
      const before = required(run.states[tick]),
        original = canonical(before);
      const recovered = transitionCombatRuntime(before, "recover");
      validateCombatCheckpoint(recovered);
      expect(
        recovered.combat.tanks.every(
          (tank) =>
            tank.secondary.ammo === 9 &&
            tank.secondary.action.kind === "ready" &&
            tank.lifecycle === "available",
        ),
      ).toBe(true);
      expect(
        recovered.combat.projectiles.filter((p) => p.definitionId === CANNON_ATTACK.id),
      ).toEqual(before.combat.projectiles.filter((p) => p.definitionId === CANNON_ATTACK.id));
      expect(canonical(before)).toBe(original);
      const paused = transitionCombatRuntime(before, "pause");
      validateCombatCheckpoint(paused);
    }
    const inFlight = required(run.states[21]);
    let disconnected = inFlight;
    for (let i = 0; i < 15; i++) {
      disconnected = stageCombatRuntime(disconnected, []).state;
      validateCombatCheckpoint(disconnected);
    }
    expect(
      disconnected.combat.tanks.every((t) => t.lifecycle === "available" && t.secondary.ammo === 9),
    ).toBe(true);
  });

  it.each([19, 20])(
    "settles lethal hull damage from boundary %i without refunding or erasing a released shell",
    (tick) => {
      const world = structuredClone(required(recordCannonCombat(1).states[tick]).combat),
        tank = required(world.tanks[0]);
      tank.armor = 1;
      tank.invulnerableTicks = 0;
      world.projectiles.push({
        id: world.nextEntityId++,
        ownerId: 20,
        team: 2,
        actionInstanceId: world.nextActionId++,
        definitionId: 3,
        position: { x: tank.body.x - pixels(24), y: tank.body.y - pixels(12) },
        velocity: { x: pixels(14), y: 0 },
        spawnTick: tick,
      });
      // Birth is stationary, so place the hostile projectile on the preceding accepted boundary.
      required(world.projectiles.at(-1)).spawnTick--;
      const next = stepCombatLab(world, [
        {
          held: 0,
          jumpPressed: false,
          firePressed: false,
          grenadePressed: false,
          interactPressed: false,
        },
      ]);
      expect(next.tanks[0]).toMatchObject({
        lifecycle: "wreck",
        occupantId: null,
        secondary: { ammo: 9, shotsFired: 1, action: { kind: "ready" } },
      });
      expect(next.players[0]).toMatchObject({ life: "alive", vehicleId: null, lives: 3 });
      expect(next.projectiles.filter((p) => p.definitionId === CANNON_ATTACK.id)).toHaveLength(
        tick === 20 ? 1 : 0,
      );
    },
  );

  it("restores solo and four-player input, wire, archive and journal boundaries", async () => {
    const proof = await cannonCombatProof();
    expect(proof.cases.map((c) => c.checkpoints.length)).toEqual([
      CANNON_BOUNDARIES.length,
      CANNON_BOUNDARIES.length,
    ]);
    expect(proof.cases.every((c) => c.notices.some((n) => n.kind === "explosion"))).toBe(true);
  });

  it("rejects stock fabrication, cursor replay, hardpoint identity reuse and invented shell headings", () => {
    const original = required(recordCannonCombat().states[21]);
    const changes: Array<(state: CombatRuntime) => void> = [
      (s) => required(s.combat.tanks[0]).secondary.ammo++,
      (s) => (required(s.combat.tanks[0]).secondary.action.nextMarkerIndex = 0),
      (s) =>
        (required(s.combat.tanks[0]).secondary.shotOrdinal = required(
          s.combat.tanks[0],
        ).weapon.shotOrdinal),
      (s) => (required(s.combat.tanks[0]).lastCannonOwnerId = 2),
      (s) =>
        required(s.combat.projectiles.find((p) => p.definitionId === CANNON_ATTACK.id)).velocity
          .x++,
    ];
    for (const change of changes) {
      const state = structuredClone(original);
      change(state);
      expect(() => validateCombatCheckpoint(state)).toThrow();
    }
    const profile = structuredClone(TANK_PROFILE);
    profile.cannon.releaseTick++;
    expect(() => validateTankProfile(profile, COMBAT_SHAPES, COMBAT_CATALOG)).toThrow();
  });
});
