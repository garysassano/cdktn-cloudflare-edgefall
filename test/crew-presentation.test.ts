import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { Held } from "../src/game/input/types.js";
import { type CombatCommand, stepCombatLab } from "../src/game/labs/combat.js";
import { TANK_PROFILE } from "../src/game/labs/combat-content.js";
import { initialCastMotion, tankPresentation } from "../src/shared/animation/cast.js";
import type { NativeAtlas } from "../src/shared/animation/native.js";
import { operativePresentation } from "../src/shared/animation/operative.js";
import {
  OPERATIVE_EJECTION_TICKS,
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../src/shared/animation/operative-motion.js";
import { recordTankCombat, tankDamageInput, tankInput } from "./fixtures/tank-proof.js";

const hero: NativeAtlas = JSON.parse(
  await readFile("public/assets/art/hero/operative.atlas.json", "utf8"),
);
const tankAtlas: NativeAtlas = JSON.parse(
  await readFile("public/assets/art/vehicles/kestrel.atlas.json", "utf8"),
);
const damage = recordTankCombat(196, tankDamageInput).states.map((s) => s.combat);
const ordinary = recordTankCombat(99, tankInput).states.map((s) => s.combat);
const neutral: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  specialPressed: false,
  interactPressed: false,
};
const releaseTick = damage.findIndex((state, tick) => {
  const old = damage[tick - 1]?.players[3],
    actor = state.players[3];
  return old?.vehicleId !== null && old?.vehicleId !== undefined && actor?.vehicleId === null;
});
const before = damage[releaseTick - 1],
  released = damage[releaseTick];
if (!before || !released || releaseTick < 1) throw new Error("Missing actual emergency release");
const old = before.players[3],
  actor = released.players[3];
if (!old || !actor) throw new Error("Missing released driver");
const releaseMotion = advanceOperativeMotion(
  old,
  actor,
  initialOperativeMotion(old, before.tick),
  released.tick,
  hero,
);

describe("accepted crew transfers", () => {
  it("keeps all eight emergency recovery poses at the safe root, then restores layered art", () => {
    const untouched = damage.map(canonical);
    expect(actor.life).toBe("alive");
    expect(actor.body.grounded).toBe(true);
    expect(actor.controlEpoch).toBe(old.controlEpoch + 1);
    expect(actor.invulnerableTicks).toBe(TANK_PROFILE.exitProtectionTicks);
    const frames: string[] = [];
    let motion = releaseMotion;
    for (let age = 0; age <= OPERATIVE_EJECTION_TICKS; age++) {
      const world = damage[releaseTick + age],
        previous = damage[releaseTick + age - 1];
      const player = world?.players[3],
        prior = previous?.players[3];
      if (!world || !player || !prior) throw new Error("Missing recovery boundary");
      if (age) motion = advanceOperativeMotion(prior, player, motion, world.tick, hero);
      const drawing = operativePresentation(player, world.tick, hero, motion);
      expect(drawing).toMatchObject({
        x: Math.round(player.body.x / 256),
        y: Math.round(player.body.y / 256),
      });
      expect(player.invulnerableTicks).toBe(TANK_PROFILE.exitProtectionTicks - age);
      if (age < OPERATIVE_EJECTION_TICKS) {
        expect(drawing?.fullBodyFrame).toMatch(/^p4\/body-eject-/);
        expect(drawing?.legsFrame).toBeNull();
        expect(drawing?.upperFrame).toBeNull();
        frames.push(drawing?.fullBodyFrame ?? "missing");
      } else {
        expect(drawing?.fullBodyFrame).toBeNull();
        expect(drawing?.upperFrame).not.toBeNull();
      }
    }
    expect(new Set(frames).size).toBe(8);
    expect(damage.map(canonical)).toEqual(untouched);
    // A cold observation has no accepted transfer to replay.
    expect(initialOperativeMotion(actor, released.tick).ejectionStartTick).toBeNull();
  });

  it.each([
    ["movement", { held: Held.Left }],
    ["aim", { held: Held.Up }],
    ["crouch", { held: Held.Down }],
    ["jump", { jumpPressed: true }],
    ["fire", { held: Held.Fire, firePressed: true }],
    ["grenade", { grenadePressed: true }],
  ])("yields on the first accepted %s input", (_, intent: Partial<CombatCommand>) => {
    const commands = released.players.map((_, slot) => ({
      ...neutral,
      ...(slot === 3 ? intent : {}),
    }));
    const next = stepCombatLab(released, commands),
      player = next.players[3];
    if (!player) throw new Error("Missing controlled driver");
    const motion = advanceOperativeMotion(actor, player, releaseMotion, next.tick, hero),
      drawing = operativePresentation(player, next.tick, hero, motion);
    expect(motion.ejectionStartTick).toBeNull();
    expect(drawing?.fullBodyFrame).toBeNull();
    expect(drawing?.upperFrame).not.toBeNull();
    if (intent.firePressed) {
      expect(player.weapon.shotOrdinal).toBe(actor.weapon.shotOrdinal + 1);
      expect(next.events.some((e) => e.kind === "shot" && e.ownerId === player.playerId)).toBe(
        true,
      );
      expect(drawing?.muzzle).not.toBeNull();
    }
    if (intent.jumpPressed) expect(player.body.grounded).toBe(false);
    if (intent.held === Held.Left) expect(player.body.x).toBeLessThan(actor.body.x);
  });

  it("shows seven crew poses before each seat marker and never invents emergency recovery on ordinary exit", () => {
    const board = new Set<string>(),
      exit = new Set<string>();
    let exits = 0;
    for (const state of ordinary) {
      const clock = initialCastMotion(state),
        tank = state.tanks[0],
        player = state.players[0],
        previous = ordinary[state.tick - 1]?.players[0];
      if (!tank || !clock.tanks[0] || !player) throw new Error("Missing ordinary transfer");
      const drawing = tankPresentation(tank, state.tick, tankAtlas, clock.tanks[0]).at(-1);
      if (tank.lifecycle === "boarding") board.add(drawing?.frame ?? "missing");
      if (tank.lifecycle === "exiting") exit.add(drawing?.frame ?? "missing");
      if (
        previous?.vehicleId !== null &&
        previous?.vehicleId !== undefined &&
        player.vehicleId === null
      ) {
        expect(previous.action.kind).toBe("exit");
        const motion = advanceOperativeMotion(
          previous,
          player,
          initialOperativeMotion(previous, state.tick - 1),
          state.tick,
          hero,
        );
        expect(motion.ejectionStartTick).toBeNull();
        exits++;
      }
    }
    expect(board.size).toBe(7);
    expect(exit.size).toBe(7);
    expect(exits).toBe(1);
  });
});
