import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileLdtk } from "../scripts/lib/ldtk.js";
import { CONTRACT_FIXTURE } from "../src/game/content/contract-fixture.js";

// Schema-complete, synthetic authoring fixture; not claimed as an editor round-trip.
const original = JSON.parse(readFileSync("content/engineering/navigation.ldtk", "utf8"));
const compile = (raw = structuredClone(original)) => compileLdtk(raw, CONTRACT_FIXTURE);
describe("LDtk content compiler", () => {
  it("merges the rendered terrain and proves the complete checkpoint route", () => {
    const result = compile();
    expect(result.gameplay.terrain.map((t) => t.id)).toEqual([1501, 1514, 1529]);
    expect(result.gameplay.terrain.map((t) => t.rect)).toEqual([
      { x: 0, y: 76800, w: 25600, h: 10240 },
      { x: 33280, y: 76800, w: 30720, h: 10240 },
      { x: 71680, y: 76800, w: 56320, h: 10240 },
    ]);
    expect(result.gameplay.route.costTicks).toBe(117);
    expect(result.gameplay.route.linkIds).toEqual([1000005, 1000006]);
    expect(result.gameplay.spawns[0]?.actor.body.supportId).toBe(1501);
    expect(result.gameplay.definitions).not.toHaveProperty("terrain");
  });
  it("ignores editor ordering/metadata without mutating either input", () => {
    const raw = structuredClone(original),
      library = structuredClone(CONTRACT_FIXTURE);
    const expected = compileLdtk(raw, library);
    expect(raw).toEqual(original);
    expect(library).toEqual(CONTRACT_FIXTURE);
    raw.bgColor = "#000000";
    raw.levels[0].layerInstances.reverse();
    raw.defs.layers.reverse();
    raw.defs.entities.reverse();
    for (const layer of raw.levels[0].layerInstances) {
      layer.gridTiles.reverse();
      layer.entityInstances.reverse();
      for (const entity of layer.entityInstances) entity.fieldInstances.reverse();
    }
    library.shapes.reverse();
    library.actors.reverse();
    expect(compileLdtk(raw, library)).toEqual(expected);
  });
  it("separates visible tile changes from gameplay identity", () => {
    const raw = structuredClone(original),
      expected = compile();
    raw.levels[0].layerInstances[1].gridTiles[0].f = 1;
    const changed = compile(raw);
    expect(changed.contentHash).toBe(expected.contentHash);
    expect(changed.graphicsHash).not.toBe(expected.graphicsHash);
  });
  it.each([
    [
      "wrong schema type",
      (raw: typeof original) => {
        raw.levels[0].pxWid = "500";
      },
      /schema/,
    ],
    [
      "missing schema field",
      (raw: typeof original) => {
        delete raw.levels[0].iid;
      },
      /schema/,
    ],
    [
      "unrecognized version",
      (raw: typeof original) => {
        raw.jsonVersion = "1.6.0";
      },
      /version/,
    ],
    [
      "external levels",
      (raw: typeof original) => {
        raw.externalLevels = true;
      },
      /embedded/,
    ],
    [
      "unsupported terrain",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[0].intGridCsv[0] = 3;
      },
      /terrain value/,
    ],
    [
      "invisible collision",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[1].gridTiles.pop();
      },
      /visible tile/,
    ],
    [
      "hidden gameplay layer",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[1].visible = false;
      },
      /visible and opaque/,
    ],
    [
      "duplicate entity handle",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[2].entityInstances[1].fieldInstances[0].__value = 1000000;
      },
      /stable entity ID/,
    ],
    [
      "floating ground spawn",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[2].entityInstances.at(-1).px[1] = 290;
      },
      /grounded spawn/,
    ],
    [
      "missing camera",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[2].entityInstances.splice(2, 1);
      },
      /one Camera/,
    ],
    [
      "blocked exit",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[2].entityInstances[4].px[1] = 290;
      },
      /exit obstructed/,
    ],
    [
      "impossible checkpoint route",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[2].entityInstances.splice(6, 1);
      },
      /route unreachable/,
    ],
    [
      "invalid jump envelope",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[2].entityInstances[5].fieldInstances.find(
          (f: { __identifier: string }) => f.__identifier === "DestinationX",
        ).__value = 204;
      },
      /landing|destination/i,
    ],
    [
      "escaping tileset",
      (raw: typeof original) => {
        raw.defs.tilesets[0].relPath = "../terrain.png";
      },
      /contained path/,
    ],
    [
      "offset layer",
      (raw: typeof original) => {
        raw.levels[0].layerInstances[0].__pxTotalOffsetX = 1;
      },
      /offset/,
    ],
  ])("rejects %s", (_name, mutate, message) => {
    const raw = structuredClone(original);
    mutate(raw);
    expect(() => compile(raw)).toThrow(message);
  });
  it("rejects a physically executable route that leaves authored kill bounds", () => {
    const raw = structuredClone(original);
    const entities = raw.levels[0].layerInstances[2].entityInstances;
    entities[2].px[1] = 250;
    entities[2].height = 110;
    entities[3].px[1] = 250;
    entities[3].height = 150;
    expect(() => compile(raw)).toThrow("route leaves kill bounds");
  });
  it("keeps existing terrain handles stable when an unrelated cell is added", () => {
    const raw = structuredClone(original);
    raw.levels[0].layerInstances[0].intGridCsv[0] = 1;
    raw.levels[0].layerInstances[1].gridTiles.push({
      px: [0, 0],
      src: [0, 0],
      f: 0,
      t: 0,
      a: 1,
      d: [0],
    });
    const result = compile(raw);
    expect(result.gameplay.terrain.slice(1)).toEqual(compile().gameplay.terrain);
    expect(result.contentHash).not.toBe(compile().contentHash);
  });
  it("compiles one-way tops without merging different vertical planes", () => {
    const raw = structuredClone(original);
    raw.levels[0].layerInstances[0].intGridCsv = raw.levels[0].layerInstances[0].intGridCsv.map(
      (v: number) => (v === 1 ? 2 : v),
    );
    const result = compile(raw);
    expect(result.gameplay.terrain).toHaveLength(12);
    expect(result.gameplay.terrain.every((t) => t.kind === "one-way" && t.rect.h === 2560)).toBe(
      true,
    );
    expect(result.gameplay.route.costTicks).toBe(117);
  });
  it("retains typed library reference validation before level compilation", () => {
    const library = structuredClone(CONTRACT_FIXTURE);
    if (!library.weapons[0]) throw new Error("Missing fixture weapon");
    library.weapons[0].timelineId = 999999;
    expect(() => compileLdtk(original, library)).toThrow(/unknown weapon action/);
  });
});
