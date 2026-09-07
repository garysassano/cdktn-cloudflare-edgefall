import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type NativeDrawing, compileNativeArt } from "../scripts/lib/native-art.js";
import { damagePlayer, stepPlayerLife } from "../src/game/campaign/life.js";
import { canonical } from "../src/game/core/canonical.js";
import { Held } from "../src/game/input/types.js";
import {
  type CombatCommand,
  createCombatLab,
  replayCombatLab,
  stepCombatLab,
} from "../src/game/labs/combat.js";
import { COMBAT_CATALOG } from "../src/game/labs/combat-content.js";
import { nativeExposure } from "../src/shared/animation/native.js";
import { OPERATIVE_POSES, operativePresentation } from "../src/shared/animation/operative.js";
import {
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../src/shared/animation/operative-motion.js";
import { airbornePlayer, deathContext } from "./fixtures/death-body-proof.js";

const raw = await readFile("art/source/hero/operative.pixels.json"),
  built = await compileNativeArt(raw, "operative.png");
const source = () => JSON.parse(raw.toString()) as NativeDrawing;
describe("native operative source and playback", () => {
  it("keeps an airborne corpse off grounded settle poses and hides a removed corpse", () => {
    const killed = damagePlayer(airbornePlayer(), 0, 1, "classic").actor;
    const motion = initialOperativeMotion(killed, 20);
    const drawing = operativePresentation(killed, 20, built.atlas, motion);
    expect(drawing?.fullBodyFrame).toBe("p1/body-death-buckle");
    expect(drawing?.y).toBe(-8);
    const removed = damagePlayer(airbornePlayer(), 0, 1, "classic", "fall").actor;
    expect(
      operativePresentation(removed, 20, built.atlas, initialOperativeMotion(removed, 20)),
    ).toBeNull();
    const context = deathContext(31);
    context.anchors = [{ x: 0, y: 0 }];
    const entered = stepPlayerLife(removed, 31, "classic", context).actor;
    expect(
      operativePresentation(entered, 31, built.atlas, initialOperativeMotion(entered, 31))
        ?.fullBodyFrame,
    ).toBe("p1/body-reentry-crouch");
  });
  it("exports the exact indexed drawing pixels into padded untrimmed palette frames", async () => {
    const { data, info } = await sharp(built.png).raw().toBuffer({ resolveWithObject: true });
    expect(Object.keys(built.atlas.frames)).toHaveLength(built.source.frames.length * 4);
    const alphas = new Set<number>();
    let hiddenRgb = 0;
    for (let i = 3; i < data.length; i += 4) {
      alphas.add(data[i] ?? -1);
      if (data[i] === 0 && (data[i - 3] || data[i - 2] || data[i - 1])) hiddenRgb++;
    }
    expect([...alphas].sort()).toEqual([0, 255]);
    expect(hiddenRgb).toBe(0);
    for (const drawing of built.source.frames)
      for (const variant of built.atlas.meta.edgefall.variants) {
        const frame = built.atlas.frames[`${variant}/${drawing.id}`];
        expect(frame).toMatchObject({ trimmed: false, sourceSize: { w: 64, h: 64 } });
        if (!frame) throw new Error("Missing frame");
        const palette = Object.fromEntries(
          Object.entries({ ...built.source.palette, ...built.source.variants[variant] }).map(
            ([symbol, color]) => [symbol, Buffer.from(color, "hex")],
          ),
        );
        const expected = Buffer.alloc(64 * 64 * 4),
          actual = Buffer.alloc(64 * 64 * 4);
        for (const [y, row] of drawing.rows.entries())
          for (const [x, symbol] of [...row].entries())
            palette[symbol]?.copy(expected, ((drawing.at[1] + y) * 64 + drawing.at[0] + x) * 4);
        for (let y = 0; y < 64; y++) {
          const start = ((frame.frame.y + y) * info.width + frame.frame.x) * 4;
          data.copy(actual, y * 64 * 4, start, start + 64 * 4);
        }
        expect(actual.equals(expected), `${variant}/${drawing.id} decoded canvas`).toBe(true);
      }
    const run = built.source.clips[0];
    expect(new Set(run?.exposures.map((e) => built.frameHashes[`p1/${e.frame}`])).size).toBe(8);
    expect(built.atlas.meta.edgefall.approval).toBe("pending");
    expect((await compileNativeArt(raw, "operative.png")).png.equals(built.png)).toBe(true);
  });
  it.each([
    [
      "partial alpha",
      (s: NativeDrawing) => {
        s.palette.a = "ffffff7f";
      },
    ],
    [
      "hidden transparent RGB",
      (s: NativeDrawing) => {
        s.palette["."] = "ff000000";
      },
    ],
    [
      "unknown glyph",
      (s: NativeDrawing) => {
        if (s.frames[0]) s.frames[0].rows[0] = "?";
      },
    ],
    [
      "out of bounds",
      (s: NativeDrawing) => {
        if (s.frames[0]) s.frames[0].at[0] = 63;
      },
    ],
    [
      "detached muzzle",
      (s: NativeDrawing) => {
        if (s.frames[0]?.sockets) s.frames[0].sockets.muzzle = [-24, -48];
      },
    ],
    [
      "detached grip",
      (s: NativeDrawing) => {
        if (s.frames[0]?.sockets) s.frames[0].sockets.grip = [15, -23];
      },
    ],
    [
      "detached action hand",
      (s: NativeDrawing) => {
        const drawing = s.frames.find((f) => f.id === "upper-grenade-release");
        if (drawing?.sockets) drawing.sockets.hand = [-24, -48];
      },
    ],
    [
      "wrong clip channel",
      (s: NativeDrawing) => {
        if (s.clips[0]) s.clips[0].channel = "upper";
      },
    ],
  ] as const)("rejects %s in editable source", async (_name, mutate) => {
    const next = source();
    mutate(next);
    await expect(
      compileNativeArt(Buffer.from(JSON.stringify(next)), "operative.png"),
    ).rejects.toThrow();
  });
  it("uses authored exposures for loop/hold playback without gameplay callbacks", () => {
    const clip = {
      id: "sample",
      channel: "legs" as const,
      mode: "loop" as const,
      exposures: [
        { frame: "contact", ticks: 2 },
        { frame: "pass", ticks: 3 },
      ],
    };
    expect([0, 1, 2, 4, 5, 7].map((tick) => nativeExposure(clip, tick))).toEqual([
      "contact",
      "contact",
      "pass",
      "pass",
      "contact",
      "pass",
    ]);
    expect(nativeExposure({ ...clip, mode: "hold-last" }, 100)).toBe("pass");
    expect(() => nativeExposure(clip, -1)).toThrow();
    expect(() => nativeExposure(clip, 1.5)).toThrow();
    expect(() => nativeExposure({ ...clip, exposures: [] }, 0)).toThrow();
  });
  it("binds every sidearm muzzle to the simulation and reflects around a fixed feet root", () => {
    const actor = createCombatLab("range").players[0];
    if (!actor) throw new Error("Missing operative");
    for (const [name, poseId] of Object.entries(OPERATIVE_POSES)) {
      const muzzle = COMBAT_CATALOG.poses.get(poseId)?.sockets.find((s) => s.name === "muzzle");
      expect(built.atlas.meta.edgefall.drawings[name]?.sockets?.muzzle).toEqual([
        Number(muzzle?.point.x) / 256,
        Number(muzzle?.point.y) / 256,
      ]);
    }
    actor.body.x = 100 * 256;
    actor.body.y = 100 * 256;
    for (const facing of [-1, 1] as const) {
      actor.facing = facing;
      const draw = operativePresentation(actor, 0, built.atlas, initialOperativeMotion(actor, 0));
      expect(draw?.muzzle).toEqual({ x: 100 + facing * 15, y: 77 });
      if (!draw) throw new Error("Missing drawing");
      // Actual Phaser canvas-flip geometry, including its unequal root margins.
      const rootWorldX =
        facing > 0 ? draw.x - draw.originX * 64 + 24 : draw.x + 64 - draw.originX * 64 - 24;
      expect(rootWorldX).toBe(100);
    }
  });
  it("keeps the run moving across sidearm actions and reconstructs it from accepted state", () => {
    let state = createCombatLab("range");
    const initial = state.players[0];
    if (!initial) throw new Error("Missing operative");
    let motion = initialOperativeMotion(initial, 0);
    const sampled = new Set<string>(),
      firing = new Set<string>();
    for (let tick = 1; tick <= 24; tick++) {
      const previous = state.players[0];
      state = stepCombatLab(state, [
        {
          held: Held.Right | Held.Fire,
          jumpPressed: false,
          firePressed: tick === 1,
          grenadePressed: false,
          interactPressed: false,
        },
      ]);
      const actor = state.players[0];
      if (!actor || !previous) throw new Error("Missing operative");
      motion = advanceOperativeMotion(previous, actor, motion, state.tick, built.atlas);
      const before = canonical(state),
        draw = operativePresentation(actor, state.tick, built.atlas, motion);
      expect(canonical(state)).toBe(before);
      expect(draw?.legsFrame).toMatch(/legs-(run|start)-/);
      expect(
        operativePresentation(
          structuredClone(actor),
          state.tick,
          built.atlas,
          structuredClone(motion),
        ),
      ).toEqual(draw);
      if (draw?.legsFrame?.includes("legs-run-")) sampled.add(draw.legsFrame);
      if (actor.action.kind === "fire") firing.add(draw?.legsFrame ?? "missing");
    }
    expect(sampled.size).toBe(8);
    expect(firing.size).toBeGreaterThan(1);
    expect(state.players[0]?.weapon.shotOrdinal).toBeGreaterThan(1);
  });
  it("retains engineering fallback for weapons, life phases and actions without native drawings", () => {
    const actor = createCombatLab("range", 2).players[0],
      other = createCombatLab("range", 2).players[1];
    if (!actor || !other) throw new Error("Missing operative");
    const motion = initialOperativeMotion(actor, 0);
    expect(operativePresentation(other, 0, built.atlas, motion)).toBeNull();
    for (const kind of ["enter", "exit", "hurt"] as const)
      expect(
        operativePresentation(
          { ...actor, action: { ...actor.action, kind } },
          0,
          built.atlas,
          motion,
        ),
      ).toBeNull();
    expect(
      operativePresentation({ ...actor, life: "spectating" }, 0, built.atlas, motion),
    ).toBeNull();
    expect(operativePresentation({ ...actor, vehicleId: 5 }, 0, built.atlas, motion)).toBeNull();
  });
  it("matches planted contact positions at successive authored exposure boundaries", () => {
    const run = built.source.clips[0];
    if (!run) throw new Error("Missing run");
    const positions = new Map<string, number>();
    let tick = 0;
    for (const exposure of run.exposures) {
      const contact = built.atlas.meta.edgefall.drawings[exposure.frame]?.contact;
      if (!contact) throw new Error("Missing contact");
      const world = tick * 3 + contact.point[0];
      expect(contact.point[1]).toBe(0);
      if (positions.has(contact.foot)) expect(world).toBe(positions.get(contact.foot));
      positions.set(contact.foot, world);
      tick += exposure.ticks;
    }
    expect(positions.size).toBe(2);
  });
  it("rejects detached boot contacts and stale, skipped or repeated presentation ticks", async () => {
    const data = source(),
      frame = data.frames.find((frame) => frame.contact);
    if (!frame?.contact) throw new Error("Missing authored contact");
    frame.contact.point = [-24, 0];
    await expect(
      compileNativeArt(Buffer.from(JSON.stringify(data)), "operative.png"),
    ).rejects.toThrow(/boot/);
    const actor = createCombatLab("range").players[0];
    if (!actor) throw new Error("Missing operative");
    const clock = initialOperativeMotion(actor, 0);
    expect(() => advanceOperativeMotion(actor, actor, clock, 0, built.atlas)).toThrow(/repeated/);
    expect(() => advanceOperativeMotion(actor, actor, clock, 2, built.atlas)).toThrow(/skipped/);
    expect(() => operativePresentation(actor, 1, built.atlas, clock)).toThrow(/stale/);
    const rejoined = { ...actor, controlEpoch: actor.controlEpoch + 1 };
    expect(advanceOperativeMotion(actor, rejoined, clock, 1, built.atlas)).toEqual(
      initialOperativeMotion(rejoined, 1),
    );
  });
  it("uses the base muzzle at release and three authored recoil drawings for every aim", () => {
    const actor = createCombatLab("range").players[0];
    if (!actor) throw new Error("Missing operative");
    for (const [name, poseId] of Object.entries(OPERATIVE_POSES)) {
      actor.aim = name === "upper-up" ? 1 : name === "upper-down" ? 2 : 0;
      actor.locomotion =
        name === "upper-crouch" ? "crouched" : name === "upper-down" ? "airborne" : "grounded";
      actor.action = { ...actor.action, kind: "fire", definitionId: poseId, stateStartTick: 20 };
      const frames = [];
      for (let age = 0; age < 4; age++)
        frames.push(
          operativePresentation(
            actor,
            20 + age,
            built.atlas,
            initialOperativeMotion(actor, 20 + age),
          )?.upperFrame,
        );
      expect(frames).toEqual([`p1/${name}`, `p1/${name}-kick`, `p1/${name}-settle`, `p1/${name}`]);
    }
  });
  it("starts, reverses, stops and crouches without delaying accepted jump/fire or restarting the gait on a shot", () => {
    let state = createCombatLab("range");
    const initial = state.players[0];
    if (!initial) throw new Error("Missing operative");
    let motion = initialOperativeMotion(initial, 0);
    const commands: CombatCommand[][] = [];
    const step = (held = 0, jumpPressed = false, firePressed = false) => {
      const before = state.players[0];
      const input = [
        { held, jumpPressed, firePressed, grenadePressed: false, interactPressed: false },
      ];
      state = stepCombatLab(state, input);
      commands.push(input);
      const actor = state.players[0];
      if (!before || !actor) throw new Error("Missing operative");
      motion = advanceOperativeMotion(before, actor, motion, state.tick, built.atlas);
      return operativePresentation(actor, state.tick, built.atlas, motion);
    };
    expect(step(Held.Right, false, true)?.legsFrame).toBe("p1/legs-start-brace");
    expect(step(Held.Right)?.upperFrame).toBe("p1/upper-horizontal-kick");
    expect(step(Held.Right)?.legsFrame).toBe("p1/legs-run-0");
    const start = motion.runStartTick;
    expect(step(Held.Left)?.legsFrame).toBe("p1/legs-reverse-pivot");
    expect(motion.runStartTick).toBe(start);
    expect(step()?.legsFrame).toBe("p1/legs-stop-brake");
    expect(step(Held.Down)?.legsFrame).toBe("p1/legs-crouch-mid");
    expect(step(0, true)?.legsFrame).toBe("p1/legs-rise");
    expect(state.players[0]?.locomotion).toBe("airborne");
    while (state.players[0]?.locomotion === "airborne" && state.tick < 120) step();
    expect(motion.transition).toBe("land");
    const y = state.players[0]?.body.y ?? 0,
      shots = state.players[0]?.weapon.shotOrdinal ?? 0;
    expect(step(0, true, true)?.legsFrame).toBe("p1/legs-rise");
    expect(state.players[0]?.body.y).toBeLessThan(y);
    expect(state.players[0]?.weapon.shotOrdinal).toBe(shots + 1);
    const recording = {
      format: 9 as const,
      scenario: state.scenario,
      players: 1,
      commands,
      finalState: canonical(state),
    };
    let observed = 0;
    expect(
      replayCombatLab(recording, (copy) => {
        observed++;
        if (copy.players[0]) copy.players[0].body.x = 0;
      }),
    ).toEqual(state);
    expect(observed).toBe(commands.length + 1);
  });
  it.each(["run", "air", "crouch"] as const)(
    "keeps %s movement and the real grenade release aligned with the drawn hand",
    (mode) => {
      let state = createCombatLab("range");
      const initial = state.players[0];
      if (!initial) throw new Error("Missing operative");
      let motion = initialOperativeMotion(initial, 0);
      const legs = new Set<string>();
      let releases = 0;
      for (let age = 0; age < 20; age++) {
        const before = state.players[0];
        state = stepCombatLab(state, [
          {
            held: mode === "crouch" ? Held.Down : Held.Right,
            jumpPressed: mode === "air" && age === 0,
            firePressed: false,
            grenadePressed: age === 0,
            interactPressed: false,
          },
        ]);
        const actor = state.players[0];
        if (!actor || !before) throw new Error("Missing operative");
        motion = advanceOperativeMotion(before, actor, motion, state.tick, built.atlas);
        const identity = canonical(state);
        const draw = operativePresentation(actor, state.tick, built.atlas, motion);
        expect(canonical(state)).toBe(identity);
        expect(draw?.fullBodyFrame).toBeNull();
        expect(draw?.upperFrame).toMatch(/upper-(grenade-|action-ready)/);
        if (draw?.legsFrame) legs.add(draw.legsFrame);
        for (const event of state.events.filter((event) => event.kind === "throw")) {
          expect(age).toBe(4);
          expect(draw?.hand?.x).toBeCloseTo(event.position.x / 256, 0);
          expect(draw?.hand?.y).toBeCloseTo(event.position.y / 256, 0);
          releases++;
        }
        if (mode === "air") expect(actor.locomotion).toBe("airborne");
      }
      expect(releases).toBe(1);
      if (mode === "run") expect(legs.size).toBeGreaterThan(6);
    },
  );
  it.each([false, true])("draws the complete authoritative knife window (crouch=%s)", (crouch) => {
    let state = createCombatLab("range");
    const initial = state.players[0],
      target = state.targets[0];
    if (!initial || !target) throw new Error("Missing fixture");
    target.enemy.body.x = 70 * 256;
    let motion = initialOperativeMotion(initial, 0);
    let active = 0;
    for (let age = 0; age < 18; age++) {
      const before = state.players[0];
      state = stepCombatLab(state, [
        {
          held: crouch ? Held.Down : 0,
          jumpPressed: false,
          firePressed: age === 0,
          grenadePressed: false,
          interactPressed: false,
        },
      ]);
      const actor = state.players[0];
      if (!before || !actor) throw new Error("Missing operative");
      motion = advanceOperativeMotion(before, actor, motion, state.tick, built.atlas);
      const draw = operativePresentation(actor, state.tick, built.atlas, motion);
      expect(draw?.upperFrame).toMatch(/upper-(melee-|action-ready)/);
      expect(draw?.fullBodyFrame).toBeNull();
      if (state.strikes.length) {
        expect(draw?.upperFrame).toContain("melee-strike");
        expect(draw?.hand).toEqual({
          x: actor.body.x / 256 + 10,
          y: actor.body.y / 256 + (crouch ? -12 : -20),
        });
        active++;
      }
    }
    expect(active).toBe(4);
    expect(state.players[0]?.weapon.shotOrdinal).toBe(0);
  });
  it("replaces all layers through real death/reentry and releases control on the authoritative entry tick", () => {
    let state = createCombatLab("rifle");
    const initial = state.players[0];
    if (!initial) throw new Error("Missing operative");
    let motion = initialOperativeMotion(initial, 0),
      death = false,
      entry = false;
    const deadFrames = new Set<string>(),
      entryFrames = new Set<string>();
    for (let count = 0; count < 250; count++) {
      const before = state.players[0];
      if (!before) throw new Error("Missing operative");
      const resume = before.life === "respawning" && state.tick - before.lifeStartTick === 11;
      state = stepCombatLab(state, [
        {
          held: 0,
          jumpPressed: resume,
          firePressed: resume,
          grenadePressed: false,
          interactPressed: false,
        },
      ]);
      const actor = state.players[0];
      if (!actor) throw new Error("Missing operative");
      motion = advanceOperativeMotion(before, actor, motion, state.tick, built.atlas);
      const draw = operativePresentation(actor, state.tick, built.atlas, motion);
      if (actor.life === "death" || actor.life === "respawning") {
        expect(draw?.upperFrame).toBeNull();
        expect(draw?.legsFrame).toBeNull();
        expect(draw?.muzzle).toBeNull();
        expect(draw?.hand).toBeNull();
        if (actor.life === "death") {
          death = true;
          if (draw?.fullBodyFrame) deadFrames.add(draw.fullBodyFrame);
        } else {
          entry = true;
          if (draw?.fullBodyFrame) entryFrames.add(draw.fullBodyFrame);
        }
      }
      if (resume) {
        expect(actor.life).toBe("alive");
        expect(actor.locomotion).toBe("airborne");
        expect(actor.weapon.shotOrdinal).toBe(before.weapon.shotOrdinal + 1);
        expect(draw?.fullBodyFrame).toBeNull();
        expect(draw?.legsFrame).toBe("p1/legs-rise");
        break;
      }
    }
    expect(death && entry).toBe(true);
    expect(deadFrames.size).toBe(8);
    expect(entryFrames.size).toBe(4);
  });
});
