import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { Held } from "../src/game/input/types.js";
import { stepCombatLab } from "../src/game/labs/combat.js";
import { tankCombatHurtboxes } from "../src/game/labs/combat-tanks.js";
import { tankPresentation } from "../src/shared/animation/cast.js";
import { combatAudioCues } from "../src/shared/animation/combat-audio.js";
import {
  advanceEffects,
  effectDrawings,
  initialEffects,
} from "../src/shared/animation/combat-effects.js";
import type { NativeAtlas } from "../src/shared/animation/native.js";
import { tankFeedback } from "../src/shared/animation/tank-feedback.js";
import { initialTankMotion } from "../src/shared/animation/tank-motion.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
} from "../src/shared/diagnostics/combat-checkpoint.js";
import { combatPeerContext } from "../src/shared/diagnostics/combat-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";
import { recordTankCombat, tankDamageInput } from "./fixtures/tank-proof.js";
import { recordTankSpecial } from "./fixtures/tank-special-proof.js";

const atlas = JSON.parse(
  readFileSync("public/assets/art/vehicles/kestrel.atlas.json", "utf8"),
) as NativeAtlas;
const fxAtlas = JSON.parse(
  readFileSync("public/assets/art/effects/breakwater-fx.atlas.json", "utf8"),
) as NativeAtlas;
let run: ReturnType<typeof recordTankCombat>;
function at(tick: number) {
  const state = run.states[tick];
  if (!state) throw new Error("Missing recorded damage boundary");
  return state;
}
function tankAt(tick: number) {
  const tank = at(tick).combat.tanks[3];
  if (!tank) throw new Error("Missing fourth tank");
  return tank;
}

describe("accepted tank integrity feedback", () => {
  beforeAll(() => {
    run = recordTankCombat(196, tankDamageInput);
  });

  it("plays three armor-loss cues across thirteen real impacts, without restarting the reaction on protected hits", () => {
    const impacts: number[] = [],
      debits: number[] = [];
    for (let tick = 1; tick <= 196; tick++) {
      const before = at(tick - 1).combat,
        next = at(tick).combat,
        tank = tankAt(tick),
        cues = combatAudioCues(before, next);
      if (next.events.some((event) => event.kind === "impact" && event.targetId === tank.body.id))
        impacts.push(tick);
      const damage = cues.filter((cue) => cue.kind === "tank-hit");
      if (damage.length) {
        debits.push(tick);
        expect(damage).toHaveLength(1);
        expect(damage[0]?.emitter).toBe(`tank:${tank.body.id}`);
        expect(tank.armor).toBe(tankAt(tick - 1).armor - 1);
      }
    }
    expect(impacts).toEqual([37, 43, 49, 51, 57, 63, 110, 116, 122, 124, 130, 136, 183]);
    expect(debits).toEqual([37, 110, 183]);
    expect(tankFeedback(tankAt(37), 37)).toMatchObject({ damageAgeTicks: 0, hitFlash: true });
    expect(tankFeedback(tankAt(43), 43)).toMatchObject({ damageAgeTicks: 6, hitFlash: false });
    expect(tankFeedback(tankAt(63), 63)).toMatchObject({ damageAgeTicks: 26, hitFlash: false });
    expect(tankFeedback(tankAt(67), 67).damageAgeTicks).toBeNull();
  });

  it("treats real tank contacts as metal in both native effects and sound", () => {
    for (const tick of [37, 43, 110, 116]) {
      const before = at(tick - 1).combat,
        next = at(tick).combat,
        impact = next.events.findIndex((event) => event.targetId === tankAt(tick).body.id);
      expect(impact).toBeGreaterThanOrEqual(0);
      const effects = advanceEffects(initialEffects(tick - 1), before, next);
      expect(
        effects.items.find((item) => item.id.startsWith(`${tick}:event:${impact}:`))?.clip,
      ).toBe("impact-metal");
      expect(combatAudioCues(before, next).some((cue) => cue.kind === "impact-metal")).toBe(true);
    }
  });

  it("keeps the full hull exposed and both hardpoints operational at the critical armor stage", () => {
    const before = at(110).combat,
      original = canonical(before),
      tank = tankAt(110);
    expect(
      tankCombatHurtboxes(before.tanks).filter((hurt) => hurt.entityId === tank.body.id),
    ).toHaveLength(1);
    let state = before;
    for (let tick = 111; tick <= 115; tick++)
      state = stepCombatLab(
        state,
        state.players.map((_, slot) => ({
          held: slot === 3 ? Held.Fire : 0,
          firePressed: slot === 3 && tick === 111,
          grenadePressed: slot === 3 && tick === 111,
          jumpPressed: false,
          interactPressed: false,
          specialPressed: false,
        })),
      );
    expect(state.tanks[3]).toMatchObject({ armor: 1, lifecycle: "occupied" });
    expect(state.tanks[3]?.weapon.shotOrdinal).toBeGreaterThan(0);
    expect(state.tanks[3]?.secondary).toMatchObject({ ammo: 9, shotsFired: 1 });
    expect(state.players[3]).toMatchObject({ lives: 3, vehicleId: tank.body.id });
    expect(canonical(before)).toBe(original);
  });

  it("reconstructs every damage and warning boundary from public wire state and a fresh checkpoint", async () => {
    const identity = await combatArchiveIdentity();
    for (const tick of [36, 37, 43, 67, 109, 110, 116, 120, 140, 182, 183, 195]) {
      const original = at(tick),
        context = combatPeerContext(original.snapshot, 0),
        decoded = decodeSnapshot(encodeSnapshot(original.snapshot, context), context),
        restored = await decodeCombatCheckpoint(
          await encodeCombatCheckpoint(original, identity),
          identity,
        ),
        expected = original.combat.tanks.map((tank) => tankFeedback(tank, tick));
      expect(decoded.vehicles.map((tank) => tankFeedback(tank, tick))).toEqual(expected);
      expect(restored.combat.tanks.map((tank) => tankFeedback(tank, tick))).toEqual(expected);
      expect(canonical(restored)).toBe(canonical(original));
    }
  });

  it("modulates the existing hull without changing pose roots, sockets, driver or authority", () => {
    for (const tick of [36, 37, 43, 67, 110, 116, 140, 182]) {
      const tank = tankAt(tick),
        original = canonical(tank),
        feedback = tankFeedback(tank, tick),
        frames = tankPresentation(tank, tick, atlas, initialTankMotion(tank, tick), 3);
      expect(frames).toHaveLength(4);
      expect(frames.every((frame) => frame.frame.startsWith("p4/"))).toBe(true);
      expect(
        frames.every((frame) => frame.x === tank.body.x / 256 && frame.y === tank.body.y / 256),
      ).toBe(true);
      expect(frames.every((frame) => frame.tintFill === true)).toBe(feedback.hitFlash);
      if (!feedback.hitFlash) {
        expect(frames[1]?.tint ?? 0xffffff).toBe(feedback.hullTint);
        expect(frames[2]?.tint).toBeUndefined();
      }
      expect(canonical(tank)).toBe(original);
    }
    expect(tankFeedback(tankAt(109), 109).integrity).toBe("damaged");
    expect(tankFeedback(tankAt(110), 110).integrity).toBe("critical");
    expect(tankFeedback(tankAt(183), 183)).toMatchObject({
      integrity: "wreck",
      critical: false,
      hitFlash: false,
    });
    expect(
      tankCombatHurtboxes(at(183).combat.tanks).some(
        (hurt) => hurt.entityId === tankAt(183).body.id,
      ),
    ).toBe(false);
    expect(
      tankPresentation(tankAt(183), 183, atlas, initialTankMotion(tankAt(183), 183), 3).map(
        (frame) => frame.frame,
      ),
    ).toEqual(["p4/kestrel-wreck"]);
  });

  it("retains critical smoke with reduced effects and ends new warning emissions at destruction", () => {
    const before = at(119).combat,
      next = at(120).combat,
      effects = advanceEffects(initialEffects(119), before, next);
    expect(
      effectDrawings(effects, next, fxAtlas, [], 120, true).some((drawing) =>
        drawing.frame.includes("smoke"),
      ),
    ).toBe(true);
    expect(tankFeedback(tankAt(120), 120)).toMatchObject({ critical: true, warningBright: true });
    expect(tankFeedback(tankAt(150), 150)).toMatchObject({ critical: true, warningBright: false });
    const wreck = advanceEffects(initialEffects(182), at(182).combat, at(183).combat);
    expect(wreck.items.some((item) => item.id.includes(`exhaust:${tankAt(183).body.id}`))).toBe(
      false,
    );
    expect(at(183).combat.players[3]).toMatchObject({ lives: 3, vehicleId: null });
    expect(at(195).combat.players[3]).toMatchObject({ lives: 2, life: "death" });
  });

  it("does not call sacrifice commitment an armor hit or a critical wreck", () => {
    const special = recordTankSpecial(1),
      before = special.states[61]?.combat,
      next = special.states[62]?.combat,
      tank = next?.tanks[0];
    if (!before || !next || !tank) throw new Error("Missing charge commitment");
    expect(tankFeedback(tank, 62)).toMatchObject({
      integrity: "charging",
      critical: false,
      hitFlash: false,
    });
    expect(combatAudioCues(before, next).filter((cue) => cue.kind === "tank-hit")).toEqual([]);
  });
});
