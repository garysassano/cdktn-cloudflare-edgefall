import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  type AreaAttack,
  type CardinalHeading,
  areaExposures,
  cardinalRect,
  emitArea,
} from "../src/game/combat/area-attack.js";
import { canonical } from "../src/game/core/canonical.js";
import { createCombatLab } from "../src/game/labs/combat.js";
import { AREA_PROFILES } from "../src/game/labs/combat-content.js";
import { breakwaterTerrain } from "../src/game/missions/breakwater.js";
import {
  advanceBreakwaterVisual,
  initialBreakwaterVisual,
} from "../src/shared/animation/breakwater.js";
import {
  EFFECT_BUDGET,
  EFFECT_POSTROLL,
  advanceEffects,
  effectDrawings,
  initialEffects,
} from "../src/shared/animation/combat-effects.js";
import type { NativeAtlas } from "../src/shared/animation/native.js";
import { runBreakwaterProof } from "./fixtures/breakwater-proof.js";

const atlas = JSON.parse(
  await readFile("public/assets/art/effects/breakwater-fx.atlas.json", "utf8"),
) as NativeAtlas;

describe("accepted native effects", () => {
  it("reconstructs the complete mission without mutating authority and expires terminal effects", () => {
    let visual = initialBreakwaterVisual(),
      previous: Parameters<typeof advanceBreakwaterVisual>[1] | undefined;
    const proof = runBreakwaterProof((state) => {
      const snapshot = canonical(state);
      if (previous) visual = advanceBreakwaterVisual(visual, previous, state);
      const drawings = effectDrawings(
        visual.effects,
        state.combat,
        atlas,
        breakwaterTerrain(state),
      );
      expect(drawings.length).toBeLessThanOrEqual(512);
      expect(visual.effects.items.length).toBeLessThanOrEqual(EFFECT_BUDGET);
      expect(canonical(state)).toBe(snapshot);
      previous = state;
    });
    expect(proof.state.phase).toBe("victory");
    expect(visual.bossHitTick).toBe(proof.state.combat.tick);
    expect(visual.effects.discarded).toBe(0);
    expect(
      effectDrawings(
        visual.effects,
        proof.state.combat,
        atlas,
        [],
        proof.state.combat.tick,
        false,
        true,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      effectDrawings(
        visual.effects,
        proof.state.combat,
        atlas,
        [],
        proof.state.combat.tick + EFFECT_POSTROLL,
        false,
        true,
      ),
    ).toEqual([]);
    expect(() =>
      effectDrawings(visual.effects, proof.state.combat, atlas, [], proof.state.combat.tick - 1),
    ).toThrow();
  });

  it("keeps important impacts under a hard budget and rejects duplicate accepted boundaries", () => {
    const before = createCombatLab("range"),
      next = structuredClone(before);
    next.tick++;
    const effects = advanceEffects(
      initialEffects(),
      before,
      next,
      Array.from({ length: 160 }, (_, i) => ({
        id: String(i),
        kind: i < 140 ? "pickup" : "boss-destroyed",
        x: 100,
        y: 100,
      })),
    );
    expect(effects.items).toHaveLength(EFFECT_BUDGET);
    expect(effects.discarded).toBeGreaterThan(0);
    expect(effects.items.filter((item) => item.clip === "blast")).toHaveLength(40);
    expect(effects.items.filter((item) => item.priority === 0)).toEqual([]);
    expect(() => advanceEffects(effects, before, next)).toThrow(/consecutive/);
    const reduced = effectDrawings(effects, next, atlas, [], next.tick, true);
    expect(
      reduced.filter((item) => item.frame.includes("blast")).every((item) => item.alpha === 0.65),
    ).toBe(true);
    const empty = { ...next, tick: next.tick + 1 };
    let current = effects;
    for (let tick = 2; tick <= 32; tick++)
      current = advanceEffects(current, { ...empty, tick: tick - 1 }, { ...empty, tick });
    expect(current.items).toEqual([]);
  });

  it.each([0, 1, 2, 3] as CardinalHeading[])(
    "clips native area pixels to the wall-facing volume in direction %i",
    (heading) => {
      const profile = AREA_PROFILES.get(10);
      if (!profile) throw new Error("Missing shotgun");
      const origin = { x: 100 * 256, y: 100 * 256 },
        attack: AreaAttack = {
          id: 1,
          ownerId: 1,
          team: 1,
          actionInstanceId: 1,
          definitionId: 10,
          startTick: 1,
          emitted: 0,
          cancelledTick: null,
          lobes: [],
          hits: [],
        };
      emitArea(attack, 1, profile, { origin, heading }, false);
      const world = createCombatLab("range");
      world.tick = 6;
      world.projectiles = [];
      world.areas = [attack];
      const wall = {
        id: 100,
        kind: "solid" as const,
        delta: { x: 0, y: 0 },
        rect: cardinalRect(
          origin,
          { x: 30 * 256, y: -64 * 256, w: 4 * 256, h: 128 * 256 },
          heading,
        ),
      };
      const exposure = areaExposures(attack, world.tick, profile, [wall])[0];
      const drawing = effectDrawings(initialEffects(world.tick), world, atlas, [wall])[0];
      if (!exposure || !drawing?.crop) throw new Error("Missing clipped native lobe");
      const { crop } = drawing,
        points = [];
      for (const x of [crop.x, crop.x + crop.w])
        for (const y of [crop.y, crop.y + crop.h]) {
          const dx = (x - 64) * (drawing.flipX ? -1 : 1),
            dy = (y - 64) * (drawing.flipY ? -1 : 1);
          const [tx, ty] =
            drawing.turn === -90 ? [dy, -dx] : drawing.turn === 90 ? [-dy, dx] : [dx, dy];
          points.push({ x: drawing.x + tx, y: drawing.y + ty });
        }
      expect(Math.min(...points.map((p) => p.x))).toBe(exposure.rect.x / 256);
      expect(Math.max(...points.map((p) => p.x))).toBe((exposure.rect.x + exposure.rect.w) / 256);
      expect(Math.min(...points.map((p) => p.y))).toBe(exposure.rect.y / 256);
      expect(Math.max(...points.map((p) => p.y))).toBe((exposure.rect.y + exposure.rect.h) / 256);
    },
  );
});
