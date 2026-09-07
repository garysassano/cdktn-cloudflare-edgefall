import { describe, expect, it } from "vitest";
import { damagePlayer } from "../src/game/campaign/life.js";
import { stepFirearm } from "../src/game/combat/firearm.js";
import {
  advanceFirearmAim,
  firearmVelocity,
  validateFirearmAim,
  validateFirearmSweep,
} from "../src/game/combat/firearm-aim.js";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_CATALOG, HMG_SWEEP } from "../src/game/labs/combat-content.js";
import { footActor } from "../src/game/labs/foot-fixture.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { recordHmg } from "./fixtures/hmg-proof.js";

const idle = { held: 0, firePressed: false };
const fire = { held: Held.Fire, firePressed: true };
function gun() {
  const actor = footActor();
  actor.weapon = { ...actor.weapon, id: "heavy-machine-gun", ammo: 150 };
  return actor;
}

describe("authoritative HMG heading sweep", () => {
  it.each([1, 2] as const)("holds each authored heading for two ticks toward aim %s", (aim) => {
    const actor = gun();
    actor.locomotion = "airborne";
    actor.aim = aim;
    const pitches = [];
    for (let tick = 1; tick <= 8; tick++) {
      actor.firearmAim = advanceFirearmAim(actor, tick, COMBAT_CATALOG);
      pitches.push(actor.firearmAim.pitch);
    }
    expect(pitches).toEqual([1, 1, 2, 2, 3, 3, 4, 4].map((pitch) => (aim === 1 ? pitch : -pitch)));
    expect(actor.weapon.shotOrdinal).toBe(0);
    expect(actor.weapon.ammo).toBe(150);
  });

  it("retargets from the accepted heading without restarting its exposure or an action", () => {
    const actor = gun();
    actor.aim = 1;
    actor.firearmAim = advanceFirearmAim(actor, 1, COMBAT_CATALOG);
    actor.aim = 2;
    actor.locomotion = "airborne";
    actor.firearmAim = advanceFirearmAim(actor, 2, COMBAT_CATALOG);
    expect(actor.firearmAim).toEqual({ pitch: 1, nextStepTick: 3 });
    actor.firearmAim = advanceFirearmAim(actor, 3, COMBAT_CATALOG);
    expect(actor.firearmAim).toEqual({ pitch: 0, nextStepTick: 5 });
    actor.facing = -1;
    expect(firearmVelocity(actor, pixels(18), COMBAT_CATALOG)).toEqual({ x: -4608, y: 0 });
  });

  it("changes a firing pose without repeating its release or changing cadence and ownership", () => {
    const first = stepFirearm(gun(), fire, 1, 1, COMBAT_CATALOG);
    first.actor.aim = 1;
    let result = stepFirearm(first.actor, idle, 2, first.nextActionId, COMBAT_CATALOG);
    expect(result.actor.action).toEqual({
      kind: "fire",
      actionInstanceId: 1,
      definitionId: 203,
      stateStartTick: 1,
      nextMarkerIndex: 2,
    });
    expect(result.markers).toHaveLength(0);
    result = stepFirearm(result.actor, idle, 3, result.nextActionId, COMBAT_CATALOG);
    expect(result.markers.map((item) => [item.markerIndex, item.pose.id])).toEqual([[2, 203]]);
    for (let tick = 4; tick <= 6; tick++)
      result = stepFirearm(result.actor, fire, tick, result.nextActionId, COMBAT_CATALOG);
    expect(result.actor.weapon).toMatchObject({ ammo: 148, shotOrdinal: 2, cooldownTicks: 5 });
    expect(
      result.markers
        .filter((item) => item.marker.kind === "spawn-attack")
        .map((item) => item.pose.id),
    ).toEqual([205]);
  });

  it("uses horizontal crouch immediately and clears a killed owner's independent aim", () => {
    const actor = gun();
    actor.aim = 1;
    const first = stepFirearm(actor, fire, 1, 1, COMBAT_CATALOG);
    first.actor.aim = 0;
    first.actor.locomotion = "crouched";
    const second = stepFirearm(first.actor, idle, 2, first.nextActionId, COMBAT_CATALOG);
    expect(second.actor.firearmAim).toEqual({ pitch: 0, nextStepTick: 0 });
    expect(second.actor.action).toMatchObject({
      definitionId: 17,
      actionInstanceId: 1,
      stateStartTick: 1,
    });
    expect(second.actor.weapon.ammo).toBe(149);
    const dead = damagePlayer(second.actor, 2, 1, "classic", "hit").actor;
    expect(dead.firearmAim).toEqual({ pitch: 0, nextStepTick: 0 });
    expect(() => validateFirearmAim(dead, 2, COMBAT_CATALOG)).not.toThrow();
  });

  it("falls back to the cardinal sidearm after the last HMG shot even while retargeting", () => {
    const actor = gun();
    actor.weapon.ammo = 1;
    actor.aim = 1;
    let result = stepFirearm(actor, fire, 1, 1, COMBAT_CATALOG);
    result.actor.aim = 2;
    result.actor.locomotion = "airborne";
    for (let tick = 2; tick <= 6; tick++)
      result = stepFirearm(result.actor, fire, tick, result.nextActionId, COMBAT_CATALOG);
    expect(result.actor.weapon).toMatchObject({ id: "sidearm", ammo: 0, shotOrdinal: 2 });
    expect(result.actor.firearmAim).toEqual({ pitch: -4, nextStepTick: 0 });
    expect(result.actor.action.definitionId).toBe(12);
    expect(() => validateFirearmAim(result.actor, 6, COMBAT_CATALOG)).not.toThrow();
  });

  it.each([1, -1] as const)("uses diagonal hand-to-muzzle clearance when facing %s", (facing) => {
    const world = createCombatLab("wall", 2),
      actor = world.players[1];
    if (!actor) throw new Error("Missing HMG player");
    actor.body.x = pixels(facing === 1 ? 130 : 149);
    actor.facing = facing;
    const after = stepCombatLab(
      world,
      world.players.map((_player, slot) => ({
        held: slot === 1 ? Held.Up | Held.Fire : 0,
        firePressed: false,
        grenadePressed: false,
        jumpPressed: false,
        interactPressed: false,
      })),
    );
    expect(
      after.events.filter((event) => event.ownerId === 2 && event.kind === "muzzle-blocked"),
    ).toHaveLength(1);
    expect(after.projectiles.filter((projectile) => projectile.ownerId === 2)).toHaveLength(0);
    expect(after.players[1]?.weapon.ammo).toBe(149);
  });

  it("rejects missing heading exposures, mismatched sockets and changed marker schedules", () => {
    const original = COMBAT_CATALOG.firearms.get("heavy-machine-gun");
    if (!original) throw new Error("Missing HMG profile");
    const profile = structuredClone(original);
    profile.sweep = { ...HMG_SWEEP, headings: HMG_SWEEP.headings.slice(1) };
    expect(() => validateFirearmSweep(profile, COMBAT_CATALOG)).toThrow("Incomplete");
    profile.sweep = structuredClone(HMG_SWEEP);
    const heading = profile.sweep.headings[5];
    if (!heading) throw new Error("Missing intermediate heading");
    heading.muzzle.x++;
    expect(() => validateFirearmSweep(profile, COMBAT_CATALOG)).toThrow("socket");
    const timelines = new Map(COMBAT_CATALOG.timelines);
    const timeline = structuredClone(timelines.get(203));
    if (!timeline?.markers[0]) throw new Error("Missing release marker");
    timeline.markers[0].tickOffset = 1;
    timelines.set(203, timeline);
    expect(() => validateFirearmSweep(original, { ...COMBAT_CATALOG, timelines })).toThrow(
      "schedules",
    );
  });

  it("admits four sweep streams with exact stock, recovery fields and authored projectile velocities", () => {
    const fixture = recordHmg(),
      before = canonical(fixture.states[7]);
    for (const state of fixture.states) validateCombatCheckpoint(state);
    expect(
      fixture.state.combat.players.map((player) => [
        player.weapon.ammo,
        player.weapon.shotOrdinal,
        player.lives,
      ]),
    ).toEqual(Array(4).fill([130, 20, 3]));
    expect(
      fixture.states[97]?.combat.players.every(
        (player) => player.locomotion === "crouched" && player.firearmAim.pitch === 0,
      ),
    ).toBe(true);
    const forged = structuredClone(fixture.states[7]);
    if (!forged?.combat.players[0] || !forged.combat.projectiles[0])
      throw new Error("Missing sweep boundary");
    forged.combat.players[0].firearmAim.nextStepTick = 100;
    expect(() => validateCombatCheckpoint(forged)).toThrow("turn tick");
    expect(canonical(fixture.states[7])).toBe(before);
    const badVelocity = structuredClone(fixture.states[7]);
    if (!badVelocity?.combat.projectiles[0]) throw new Error("Missing sweep bullet");
    badVelocity.combat.projectiles[0].velocity = { x: pixels(9), y: -pixels(9) };
    expect(() => validateCombatCheckpoint(badVelocity)).toThrow("projectile motion");
  });
});
