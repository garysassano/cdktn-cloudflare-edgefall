import { describe, expect, it } from "vitest";
import { validateAreaProfile } from "../src/game/combat/area-attack.js";
import { castBeam } from "../src/game/combat/beam.js";
import { createDestructible, damageDestructible } from "../src/game/combat/destructible.js";
import { type HurtTarget, muzzleBlocked, sweepProjectile } from "../src/game/combat/projectile.js";
import { explosionHits, rectangularHits } from "../src/game/combat/volume.js";
import {
  type MaterialSurface,
  SURFACE_MATERIALS,
  materialDamage,
  surfaceMaterial,
  validateSurfaceMaterials,
} from "../src/game/content/materials.js";
import { validateContent } from "../src/game/content/validate.js";
import { LASER_ATTACK, LASER_PROFILE } from "../src/game/content/weapons/laser.js";
import { canonical, stateHash } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import {
  AREA_PROFILES,
  COMBAT_ATTACKS,
  COMBAT_CONTENT,
  COMBAT_SHAPES,
} from "../src/game/labs/combat-content.js";
import {
  type MaterialRecording,
  createMaterialRecording,
  materialLabProp,
  replayMaterialLab,
} from "../src/game/labs/materials.js";
import { materialProof, recordMaterialCombat } from "./fixtures/material-proof.js";

const zero = { x: 0, y: 0 };
const rect = (x: number, y: number, w: number, h: number) => ({
  x: pixels(x),
  y: pixels(y),
  w: pixels(w),
  h: pixels(h),
});
const source = (definitionId: number) => ({
  id: 1000,
  ownerId: 1,
  team: 1,
  actionInstanceId: 1,
  definitionId,
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing material fixture content");
  return value;
}
const body = (id: number, x: number, entityId = id): HurtTarget => ({
  id,
  entityId,
  kind: "body",
  team: 2,
  rect: rect(x, -4, 4, 8),
  delta: zero,
});
const wall = (materialId: MaterialSurface["materialId"]): MaterialSurface => ({
  id: 200,
  kind: "solid",
  rect: rect(20, -8, 2, 16),
  delta: zero,
  ...(materialId === undefined ? {} : { materialId }),
});

describe("authored combat materials", () => {
  it("replays exported cooperative cover destruction and isolates observer mutations", () => {
    const fixture = recordMaterialCombat({
      weapon: "flamethrower",
      materialId: "timber",
      players: 4,
      targetMotion: "patrol",
    });
    const recording = createMaterialRecording(fixture.state, fixture.commands);
    const observed: string[] = [];
    const restored = replayMaterialLab(JSON.parse(JSON.stringify(recording)), (state) => {
      observed.push(stateHash(state));
      state.world.targets.length = 0;
      state.definition.materialId = "concrete";
    });
    expect(canonical(restored)).toBe(canonical(fixture.state));
    expect(observed).toEqual(fixture.states.map(stateHash));
    required(required(fixture.commands[0])[0]).held = 255;
    expect(required(required(recording.commands[0])[0]).held).toBe(0);
  });
  it("rejects incompatible, malformed and tampered material recordings", () => {
    const fixture = recordMaterialCombat({
      weapon: "grenade",
      materialId: "open-grating",
      players: 1,
      targetMotion: "stationary",
    });
    const recording = createMaterialRecording(fixture.state, fixture.commands);
    const cases = [
      null,
      [],
      { ...recording, format: 1 },
      { ...recording, contentFingerprint: "00000000" },
      { ...recording, finalState: "tampered" },
      { ...recording, extra: true },
      { ...recording, definition: { ...recording.definition, materialId: "missing" } },
      { ...recording, commands: [[]] },
      { ...recording, commands: [[null]] },
      { ...recording, commands: [[{}]] },
      {
        ...recording,
        commands: [[{ ...required(required(recording.commands[0])[0]), held: 256 }]],
      },
      {
        ...recording,
        commands: [[{ ...required(required(recording.commands[0])[0]), firePressed: 1 }]],
      },
      { ...recording, commands: [[{ ...required(required(recording.commands[0])[0]), extra: 1 }]] },
    ];
    for (const invalid of cases)
      expect(() => replayMaterialLab(invalid as MaterialRecording)).toThrow();
    expect(() => createMaterialRecording(fixture.state, [])).toThrow(/boundary/);
  });
  it("replays the full eight-family, four-material, one/four-player matrix with stationary and patrolling victims", {
    timeout: 20000,
  }, () => {
    const proof = materialProof();
    expect(proof.cases).toHaveLength(128);
    expect(proof.cases.reduce((total, item) => total + item.checkpoints.length, 0)).toBe(384);
    const expectedCover = {
      concrete: [8, 8, 8, 8, 8, 8, 8, 8],
      timber: [7, 7, 4, 4, 4, 6, 7, 7],
      "armor-steel": [8, 8, 8, 4, 8, 4, 8, 7],
      "open-grating": [7, 7, 4, 4, 8, 6, 8, 7],
    };
    for (const [materialId, health] of Object.entries(expectedCover)) {
      const cases = proof.cases.filter(
        (item) =>
          item.definition.players === 1 &&
          item.definition.targetMotion === "stationary" &&
          item.definition.materialId === materialId,
      );
      expect(cases.map((item) => item.coverHealth)).toEqual(health);
      expect(cases.map((item) => item.targetHealth)).toEqual(
        materialId === "open-grating"
          ? [
              [32, 32],
              [32, 32],
              [32, 32],
              [28, 28],
              [28, 29],
              [30, 30],
              [32, 32],
              [31, 32],
            ]
          : Array.from({ length: 8 }, () => [32, 32]),
      );
    }
  });
  it("samples moving blast cover at the declared impact fraction and vents only through the permeable material", () => {
    const attack = required(COMBAT_ATTACKS.get(5));
    const cover = {
      ...wall("armor-steel"),
      rect: rect(20, -24, 2, 8),
      delta: { x: 0, y: pixels(40) },
    };
    const victim = body(20, 30);
    const query = (surface: MaterialSurface, numerator: number, denominator: number) =>
      explosionHits(source(attack.id), attack, zero, pixels(48), [surface], [victim], {
        time: { numerator, denominator },
      });
    expect(query(cover, 0, 1).map((hit) => hit.entityId)).toEqual([20]);
    expect(query(cover, 1, 2)).toEqual([]);
    expect(query(cover, 1, 1).map((hit) => hit.entityId)).toEqual([20]);
    expect(
      query({ ...cover, materialId: "open-grating" }, 1, 2).map((hit) => hit.entityId),
    ).toEqual([20]);
  });
  it("retains physical bullet collision with a thin moving grating between both endpoint poses", () => {
    const definition = { ...required(COMBAT_ATTACKS.get(1)), shapeId: 99 };
    const shape = { id: 99, rect: rect(0, 0, 1, 1) };
    const cover: MaterialSurface = {
      id: 200,
      kind: "solid",
      materialId: "open-grating",
      rect: rect(10, -5, 1, 10),
      delta: { x: pixels(-30), y: 0 },
    };
    const hit = sweepProjectile(
      { ...source(definition.id), position: zero, velocity: { x: pixels(20), y: 0 }, spawnTick: 1 },
      definition,
      shape,
      [cover],
      [body(20, 40)],
    );
    expect(hit?.colliderId).toBe(200);
    expect((hit?.time.numerator ?? 0) * 50).toBe((hit?.time.denominator ?? 0) * 9);
  });
  it("lets a laser damage permeable cover and distinct actors while grouping overlapping component shapes", () => {
    const cover: HurtTarget = {
      ...body(200, 20),
      team: 0,
      solid: true,
      materialId: "open-grating",
    };
    const targets = [cover, body(20, 40), body(120, 41, 20), body(21, 60)];
    const query = (hurts: HurtTarget[]) =>
      castBeam(source(LASER_ATTACK.id), LASER_ATTACK, LASER_PROFILE, zero, 0, [], hurts);
    const beam = query(targets);
    expect(beam.stoppedBy).toBeNull();
    expect(beam.length).toBe(LASER_PROFILE.range);
    expect(beam.impacts.map((hit) => hit.entityId)).toEqual([200, 20, 21]);
    expect(query([...targets].reverse())).toEqual(beam);
    const armored = query([{ ...cover, materialId: "armor-steel" }, ...targets.slice(1)]);
    expect(armored.stoppedBy).toBe("solid");
    expect(armored.length).toBe(pixels(20));
    expect(armored.impacts.map((hit) => hit.entityId)).toEqual([200]);
  });
  it("uses the material policy for an attached muzzle while released physical bodies retain their collision", () => {
    const shape = required(COMBAT_SHAPES.get(4));
    const to = { x: pixels(30), y: 0 };
    expect(muzzleBlocked(zero, to, shape, [wall("open-grating")], "heat")).toBe(false);
    expect(muzzleBlocked(zero, to, shape, [wall("open-grating")], "energy")).toBe(false);
    expect(muzzleBlocked(zero, to, shape, [wall("open-grating")])).toBe(true);
    expect(muzzleBlocked(zero, to, shape, [wall("armor-steel")], "energy")).toBe(true);
    const fixture = recordMaterialCombat({
      weapon: "rocket-launcher",
      materialId: "open-grating",
      players: 1,
      targetMotion: "stationary",
    });
    expect(fixture.impacts.map((event) => event.impact.entityId)).toEqual([20, 21, 200]);
    expect(new Set(fixture.impacts.map((event) => event.tick)).size).toBe(1);
    expect(fixture.impacts.find((event) => event.impact.entityId === 200)?.impact.position.x).toBe(
      pixels(92),
    );
    const impactTick = required(fixture.impacts[0]).tick;
    expect(required(fixture.states[impactTick - 1]).world.rockets).toHaveLength(1);
    expect(required(fixture.states[impactTick]).world.rockets).toHaveLength(0);
  });
  it("registers a clipped solid face but rejects an ordinary body graze and a single corner", () => {
    const attack = required(COMBAT_ATTACKS.get(11));
    const volume = rect(0, -2, 20, 4),
      cover = { ...body(200, 20), team: 0, solid: true, materialId: "timber" as const };
    const query = (target: HurtTarget) =>
      rectangularHits(source(attack.id), attack, volume, zero, zero, [], [target]);
    expect(query(cover).map((hit) => hit.entityId)).toEqual([200]);
    expect(query({ ...cover, solid: false })).toEqual([]);
    expect(query({ ...cover, rect: rect(20, 2, 4, 8) })).toEqual([]);
  });
  it("retains each contacted flame lobe limit across genuine cooperative prop destruction", () => {
    const fixture = recordMaterialCombat({
      weapon: "flamethrower",
      materialId: "timber",
      players: 4,
      targetMotion: "stationary",
    });
    const destroyed = fixture.states.find((state) => state.world.props[0]?.health === 0);
    expect(destroyed).toBeDefined();
    const before = required(fixture.states[required(destroyed).world.tick - 1]);
    const limits = new Map(
      before.world.areas.flatMap((area) =>
        area.lobes.map((lobe) => [`${area.id}:${lobe.index}`, lobe.reach] as const),
      ),
    );
    expect(limits.size).toBeGreaterThan(0);
    for (const state of fixture.states.slice(required(destroyed).world.tick))
      for (const area of state.world.areas)
        for (const lobe of area.lobes) {
          const previous = limits.get(`${area.id}:${lobe.index}`);
          if (previous !== undefined) expect(lobe.reach).toBeLessThanOrEqual(previous);
        }
    expect(
      fixture.impacts.some(
        (hit) => hit.impact.entityId !== 200 && hit.tick > required(destroyed).world.tick,
      ),
    ).toBe(true);
  });
  it("rejects unknown and incomplete material definitions before mutating health", () => {
    const invalid = structuredClone(SURFACE_MATERIALS);
    delete (required(invalid[0]).blocks as Record<string, unknown>).heat;
    expect(() => validateSurfaceMaterials(invalid)).toThrow(/Incomplete/);
    expect(() => surfaceMaterial("missing" as never)).toThrow(/Unknown/);
    const definition = materialLabProp({
      weapon: "sidearm",
      materialId: "timber",
      targetMotion: "stationary",
    });
    const prop = createDestructible(definition),
      attack = required(COMBAT_ATTACKS.get(1));
    const impact = {
      sourceId: 1000,
      definitionId: attack.id,
      actionInstanceId: 1,
      ownerId: 1,
      colliderId: 200,
      entityId: 200,
      kind: "body" as const,
      damage: 1,
      position: zero,
      time: { numerator: 1, denominator: 1 },
    };
    expect(() =>
      damageDestructible(
        prop,
        { ...definition, materialId: undefined as never },
        impact,
        attack,
        1,
      ),
    ).toThrow(/Unknown/);
    expect(prop.health).toBe(8);
    const content = structuredClone(COMBAT_CONTENT);
    required(content.attacks[0]).material = "missing" as never;
    expect(() => validateContent(content)).toThrow(/unknown attack material/);
    expect(materialDamage(65535, "energy", "armor-steel")).toBe(65535);
    expect(() =>
      validateAreaProfile(required(AREA_PROFILES.get(11)), {
        ...required(COMBAT_ATTACKS.get(11)),
        material: "bullet",
      }),
    ).toThrow(/material mismatch/);
  });
});
