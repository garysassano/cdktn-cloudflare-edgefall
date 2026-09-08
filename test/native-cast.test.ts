import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Held } from "../src/game/input/types.js";
import { type CombatCommand, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { worldSocket } from "../src/game/physics/body.js";
import {
  CAST_ART,
  advanceCastMotion,
  enemyPresentation,
  initialCastMotion,
  tankPresentation,
} from "../src/shared/animation/cast.js";
import { combatAudioCues, operativeFootfalls } from "../src/shared/animation/combat-audio.js";
import type { NativeAtlas } from "../src/shared/animation/native.js";
import {
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../src/shared/animation/operative-motion.js";

const atlases = new Map(
  await Promise.all(
    [...CAST_ART, { id: "operative", directory: "hero" }].map(
      async (asset) =>
        [
          asset.id,
          JSON.parse(
            await readFile(`public/assets/art/${asset.directory}/${asset.id}.atlas.json`, "utf8"),
          ) as NativeAtlas,
        ] as const,
    ),
  ),
);
function atlas(id: string): NativeAtlas {
  const value = atlases.get(id);
  if (!value) throw new Error("Missing test atlas");
  return value;
}
const input = (values: Partial<CombatCommand> = {}): CombatCommand => ({
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  specialPressed: false,
  interactPressed: false,
  ...values,
});

describe("native cast authority and sound", () => {
  it("gives the shield bash its own cue without also playing the paired sound marker", () => {
    let state = createCombatLab("guard"),
      bashes = 0;
    for (let tick = 1; tick <= 45; tick++) {
      const next = stepCombatLab(state, [
        input({
          held: tick < 6 ? Held.Down : Held.Right,
          jumpPressed: tick === 24,
          grenadePressed: tick === 1,
        }),
      ]);
      if (next.events.some((e) => e.kind === "melee" && e.source?.definitionId === 6)) {
        const cues = combatAudioCues(state, next);
        expect(cues.filter((c) => c.kind === "bash")).toHaveLength(1);
        expect(cues.filter((c) => c.kind === "knife")).toHaveLength(0);
        bashes++;
      }
      state = next;
    }
    expect(bashes).toBe(1);
  });
  it("places every actual rifle release at its drawn muzzle, including a reflected feet root", () => {
    let state = createCombatLab("rifle"),
      motion = initialCastMotion(state);
    let releases = 0;
    for (let tick = 1; tick <= 84; tick++) {
      const next = stepCombatLab(state, [input({ held: Held.Down })]);
      motion = advanceCastMotion(state, next, motion);
      const cues = combatAudioCues(state, next);
      for (const event of next.events.filter((event) => event.kind === "shot")) {
        const target = next.targets.find((t) => t.enemy.body.id === event.ownerId);
        expect(target).toBeDefined();
        if (!target) throw new Error("Missing rifle owner");
        const drawing = enemyPresentation(
          target,
          next,
          atlas("quay-watch"),
          motion.enemies.find((c) => c.id === target.enemy.body.id)?.strideQ ?? 0,
        );
        expect(drawing?.frame).toBe("base/watch-ready");
        expect(drawing?.originX).toBe(40 / 64);
        const muzzle = atlas("quay-watch").meta.edgefall.drawings["watch-ready"]?.sockets?.muzzle;
        if (!muzzle) throw new Error("Missing drawn muzzle");
        expect(event.position).toEqual(
          worldSocket(
            target.enemy.body,
            { x: muzzle[0] * 256, y: muzzle[1] * 256 },
            target.enemy.facing,
          ),
        );
        releases++;
      }
      expect(cues.filter((c) => c.kind === "rifle")).toHaveLength(
        next.events.filter((e) => e.kind === "shot").length,
      );
      state = next;
    }
    expect(releases).toBe(6);
  });

  it("uses landing compression only after a real airborne transition", () => {
    let state = createCombatLab("tank"),
      motion = initialCastMotion(state);
    const landingFrames: number[] = [];
    let landTick: number | null = null;
    for (let tick = 1; tick <= 70; tick++) {
      const next = stepCombatLab(state, [
        input({ interactPressed: tick === 1, jumpPressed: tick === 15 }),
      ]);
      motion = advanceCastMotion(state, next, motion);
      const tank = next.tanks[0],
        old = state.tanks[0],
        clock = motion.tanks[0];
      if (!tank || !old || !clock) throw new Error("Missing tank");
      if (!old.body.grounded && tank.body.grounded) landTick = tick;
      const frames = tankPresentation(tank, tick, atlas("kestrel"), clock);
      if (frames.some((frame) => frame.frame.startsWith("p1/kestrel-hull-impact-")))
        landingFrames.push(tick);
      if (tick < 15) expect(clock.landTick).toBeNull();
      state = next;
    }
    expect(landTick).not.toBeNull();
    if (landTick === null) throw new Error("Tank never landed");
    expect(landingFrames).toEqual([
      landTick,
      landTick + 1,
      landTick + 2,
      landTick + 3,
      landTick + 4,
    ]);
  });

  it("preserves world turret headings when the hull reverses and uses all four crew palettes", () => {
    const state = createCombatLab("tank"),
      tank = state.tanks[0],
      clock = initialCastMotion(state).tanks[0];
    if (!tank || !clock) throw new Error("Missing tank");
    tank.facing = -1;
    for (let heading = 0; heading < 8; heading++)
      for (let slot = 0; slot < 4; slot++) {
        tank.heading = heading;
        const frames = tankPresentation(tank, state.tick, atlas("kestrel"), clock, slot);
        expect(frames[0]?.flipX).toBe(true);
        expect(frames[2]?.flipX).toBe(false);
        expect(frames[2]?.frame).toBe(`p${slot + 1}/kestrel-turret-${heading}`);
        expect(atlas("kestrel").frames[frames[2]?.frame ?? ""]).toBeDefined();
      }
  });

  it("does not invent a settled corpse for an airborne or unresolved removal", () => {
    const state = createCombatLab("rifle"),
      target = state.targets[0];
    if (!target) throw new Error("Missing enemy");
    target.health = 0;
    target.enemy.life = "removed";
    expect(enemyPresentation(target, state, atlas("quay-watch"), 0)).toBeNull();
    const member = state.encounter.members.find((m) => m.id === target.enemy.body.id);
    if (!member) throw new Error("Missing encounter member");
    member.reason = "killed";
    member.resolvedTick = 0;
    target.enemy.body.grounded = true;
    expect(enemyPresentation(target, state, atlas("quay-watch"), 0)?.frame).toBe(
      "base/watch-death-0",
    );
    target.enemy.body.grounded = false;
    expect(enemyPresentation(target, state, atlas("quay-watch"), 0)).toBeNull();
    target.enemy.body.grounded = true;
    state.tick = 30;
    expect(enemyPresentation(target, state, atlas("quay-watch"), 0)).toBeNull();
  });

  it("plays one footstep per authored foot change even when running starts off the global cadence", () => {
    let state = createCombatLab("range"),
      actor = state.players[0];
    if (!actor) throw new Error("Missing operative");
    let motion = initialOperativeMotion(actor, 0);
    const steps: number[] = [];
    for (let tick = 1; tick <= 40; tick++) {
      const next = stepCombatLab(state, [
          input({ held: tick >= 4 && tick < 36 ? Held.Right | Held.Fire : 0 }),
        ]),
        player = next.players[0];
      if (!player) throw new Error("Missing operative");
      motion = advanceOperativeMotion(actor, player, motion, tick, atlas("operative"));
      const cues = combatAudioCues(state, next, operativeFootfalls([motion], atlas("operative")));
      if (cues.some((c) => c.kind === "step")) steps.push(tick);
      state = next;
      actor = player;
    }
    expect(steps).toHaveLength(4);
    expect(steps[0]).not.toBe(8);
    expect(steps.slice(1).map((t, i) => t - (steps[i] ?? 0))).toEqual([8, 8, 8]);
    expect(() => combatAudioCues(state, state)).toThrow(/accepted world transition/);
    expect(() => advanceCastMotion(state, state, initialCastMotion(state))).toThrow(
      /accepted world transition/,
    );
  });
});
