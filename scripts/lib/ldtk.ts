import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import type { ContentDefinition } from "../../src/game/content/schema.js";
import { validateContent } from "../../src/game/content/validate.js";
import { canonical } from "../../src/game/core/canonical.js";
import { integer, pixels } from "../../src/game/core/numeric.js";
import { RouteFollower } from "../../src/game/navigation/follower.js";
import { NavigationGraph } from "../../src/game/navigation/graph.js";
import { CompiledTraversal } from "../../src/game/navigation/links.js";
import { WalkSurface } from "../../src/game/navigation/spans.js";
import { worldRect } from "../../src/game/physics/body.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";
import type { SweepTarget } from "../../src/game/physics/sweep.js";
import { ARCADE } from "../../src/game/rules.js";
import type { FootActor, Rect } from "../../src/game/state.js";
import schema from "../content/ldtk-1.5.3/schema.json" with { type: "json" };

// Official schema includes editor-only keyword containers and union types.
const ajv = new Ajv({ strict: false, allErrors: false });
ajv.addMetaSchema({
  $id: "https://json-schema.org/draft-07/schema",
  $ref: "http://json-schema.org/draft-07/schema",
});
const validate = ajv.compile(schema);
interface Field {
  __identifier: string;
  __type: string;
  __value: unknown;
  defUid: number;
}
interface Entity {
  __identifier: string;
  iid: string;
  defUid: number;
  px: number[];
  __pivot: number[];
  width: number;
  height: number;
  fieldInstances: Field[];
}
interface Tile {
  px: number[];
  src: number[];
  t: number;
  f: number;
  a: number;
}
interface Layer {
  __identifier: string;
  __type: string;
  iid: string;
  layerDefUid: number;
  levelId: number;
  __cWid: number;
  __cHei: number;
  __gridSize: number;
  __opacity: number;
  __pxTotalOffsetX: number;
  __pxTotalOffsetY: number;
  pxOffsetX: number;
  pxOffsetY: number;
  __tilesetDefUid: number | null;
  visible: boolean;
  intGridCsv: number[];
  gridTiles: Tile[];
  autoLayerTiles: Tile[];
  entityInstances: Entity[];
}
interface Project {
  jsonVersion: string;
  iid: string;
  externalLevels: boolean;
  worlds: unknown[];
  defs: {
    layers: Array<{
      uid: number;
      identifier: string;
      type: string;
      gridSize: number;
      parallaxFactorX: number;
      parallaxFactorY: number;
      pxOffsetX: number;
      pxOffsetY: number;
    }>;
    entities: Array<{
      uid: number;
      identifier: string;
      fieldDefs: Array<{ uid: number; identifier: string; __type: string }>;
    }>;
    tilesets: Array<{
      uid: number;
      relPath?: string | null;
      tileGridSize: number;
      pxWid: number;
      pxHei: number;
      spacing: number;
      padding: number;
    }>;
  };
  levels: Array<{
    iid: string;
    uid: number;
    pxWid: number;
    pxHei: number;
    worldX: number;
    worldY: number;
    externalRelPath?: string | null;
    layerInstances: Layer[] | null;
  }>;
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`LDtk: ${message}`);
}
function unique<T>(items: T[], key: (item: T) => string | number, label: string) {
  const map = new Map<string | number, T>();
  for (const item of items) {
    const id = key(item);
    check(!map.has(id), `duplicate ${label}: ${id}`);
    map.set(id, item);
  }
  return map;
}
function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function within(a: Rect, b: Rect) {
  return a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
}

/** Build-time compiler for one embedded, static encounter. Unsupported authoring fails explicitly. */
export function compileLdtk(raw: unknown, definitions: ContentDefinition) {
  check(validate(raw), `schema 1.5.3: ${JSON.stringify(validate.errors)}`);
  const project = raw as Project;
  check(project.jsonVersion === "1.5.3", "unsupported JSON version");
  check(
    !project.externalLevels && project.worlds.length === 0 && project.levels.length === 1,
    "expected one embedded level",
  );
  validateContent(definitions);
  const level = project.levels[0];
  check(level && !level.externalRelPath && level.layerInstances, "missing embedded level");
  check(level.worldX === 0 && level.worldY === 0, "level must use local origin");
  integer(level.pxWid, 1, 4096, "level width");
  integer(level.pxHei, 1, 4096, "level height");
  const layers = unique(level.layerInstances, (l) => l.__identifier, "layer name");
  check(layers.size === 3, "expected Collision, Gameplay and Logic layers");
  const collision = layers.get("Collision"),
    visible = layers.get("Gameplay"),
    logic = layers.get("Logic");
  check(
    collision?.__type === "IntGrid" && visible?.__type === "Tiles" && logic?.__type === "Entities",
    "unsupported layer types",
  );
  const layerDefs = unique(project.defs.layers, (d) => d.uid, "layer definition");
  unique(level.layerInstances, (l) => l.iid, "layer IID");
  unique(level.layerInstances, (l) => l.layerDefUid, "layer definition instance");
  const cell = collision.__gridSize,
    width = collision.__cWid,
    height = collision.__cHei;
  integer(cell, 1, 64, "grid size");
  integer(width * height, 1, 16384, "cell budget");
  check(width * cell === level.pxWid && height * cell === level.pxHei, "grid dimensions mismatch");
  for (const layer of level.layerInstances) {
    const def = layerDefs.get(layer.layerDefUid);
    check(
      def &&
        def.identifier === layer.__identifier &&
        def.type === layer.__type &&
        def.gridSize === cell,
      "layer definition mismatch",
    );
    check(def.parallaxFactorX === 0 && def.parallaxFactorY === 0, "gameplay parallax unsupported");
    check(
      [
        def.pxOffsetX,
        def.pxOffsetY,
        layer.__pxTotalOffsetX,
        layer.__pxTotalOffsetY,
        layer.pxOffsetX,
        layer.pxOffsetY,
      ].every((v) => v === 0),
      "layer offset unsupported",
    );
    check(
      layer.levelId === level.uid &&
        layer.__gridSize === cell &&
        layer.__cWid === width &&
        layer.__cHei === height,
      "layer dimensions/owner mismatch",
    );
    check(layer.autoLayerTiles.length === 0, "auto layers unsupported");
    check(layer === collision || layer.intGridCsv.length === 0, "unexpected collision values");
    check(layer === visible || layer.gridTiles.length === 0, "unexpected tiles");
    check(layer === logic || layer.entityInstances.length === 0, "unexpected entities");
  }
  check(visible.visible && visible.__opacity === 1, "gameplay layer must be visible and opaque");
  check(collision.intGridCsv.length === width * height, "IntGrid cell count mismatch");
  check(
    collision.intGridCsv.every((v) => v === 0 || v === 1 || v === 2),
    "unsupported terrain value",
  );
  const tilesets = unique(project.defs.tilesets, (t) => t.uid, "tileset UID");
  const tileset = tilesets.get(visible.__tilesetDefUid ?? -1);
  check(
    tileset && tileset.tileGridSize === cell && tileset.spacing === 0 && tileset.padding === 0,
    "unsupported tileset grid",
  );
  check(
    tileset.relPath &&
      !tileset.relPath.startsWith("/") &&
      !tileset.relPath.split("/").includes("..") &&
      !tileset.relPath.includes("\\"),
    "tileset must use a relative contained path",
  );
  const graphics = visible.gridTiles
    .map((tile) => {
      const [x, y] = tile.px,
        [sx, sy] = tile.src;
      check(
        tile.px.length === 2 &&
          tile.src.length === 2 &&
          x !== undefined &&
          y !== undefined &&
          sx !== undefined &&
          sy !== undefined,
        "tile coordinates",
      );
      integer(x, 0, level.pxWid - cell, "tile x");
      integer(y, 0, level.pxHei - cell, "tile y");
      check(
        x % cell === 0 && y % cell === 0 && sx % cell === 0 && sy % cell === 0,
        "unaligned tile",
      );
      integer(sx, 0, tileset.pxWid - cell, "tile source x");
      integer(sy, 0, tileset.pxHei - cell, "tile source y");
      integer(tile.f, 0, 3, "tile flip");
      check(
        tile.a === 1 && tile.t === (sy / cell) * (tileset.pxWid / cell) + sx / cell,
        "tile opacity/index mismatch",
      );
      return { x, y, sx, sy, flip: tile.f, tile: tile.t };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const tiles = unique(graphics, (t) => (t.y / cell) * width + t.x / cell, "visible tile cell");
  const terrain: SweepTarget[] = [];
  const open = new Map<string, SweepTarget>();
  // Merge equal horizontal runs only across adjacent rows, retaining the anchor cell's stable ID.
  for (let y = 0; y < height; y++) {
    const next = new Map<string, SweepTarget>();
    for (let x = 0; x < width; ) {
      const value = collision.intGridCsv[y * width + x];
      if (!value) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && collision.intGridCsv[y * width + x] === value) {
        check(tiles.has(y * width + x), `collision cell ${x},${y} has no visible tile`);
        x++;
      }
      const key = `${start}:${x}:${value}`;
      const previous = value === 1 ? open.get(key) : undefined;
      const target = previous ?? {
        id: 1 + y * width + start,
        kind: value === 1 ? ("solid" as const) : ("one-way" as const),
        rect: {
          x: pixels(start * cell),
          y: pixels(y * cell),
          w: pixels((x - start) * cell),
          h: pixels(cell),
        },
        delta: { x: 0, y: 0 },
      };
      if (previous) target.rect.h += pixels(cell);
      else terrain.push(target);
      next.set(key, target);
    }
    open.clear();
    for (const [key, value] of next) open.set(key, value);
  }
  check(terrain.length > 0 && terrain.length <= 4096, "terrain budget");
  const entityDefs = unique(project.defs.entities, (e) => e.uid, "entity definition");
  check(logic.entityInstances.length <= 512, "entity budget");
  unique(logic.entityInstances, (e) => e.iid, "entity IID");
  const entities = logic.entityInstances
    .map((entity) => {
      const def = entityDefs.get(entity.defUid);
      check(def?.identifier === entity.__identifier, "entity definition mismatch");
      const fields = unique(entity.fieldInstances, (f) => f.__identifier, "entity field");
      const fieldDefs = unique(def.fieldDefs, (f) => f.uid, "field definition");
      for (const field of entity.fieldInstances) {
        const declared = fieldDefs.get(field.defUid);
        check(
          declared?.identifier === field.__identifier && declared.__type === field.__type,
          "field definition mismatch",
        );
      }
      const number = (name: string) => {
        const field = fields.get(name);
        check(
          field?.__type === "Int" && typeof field.__value === "number",
          `missing integer ${name}`,
        );
        return integer(field.__value, -65536, 2 ** 24, name);
      };
      const id = number("StableId");
      integer(id, 1_000_000, 2 ** 24, "entity stable ID");
      const [x, y] = entity.px;
      check(
        entity.px.length === 2 &&
          x !== undefined &&
          y !== undefined &&
          entity.__pivot[0] === 0 &&
          entity.__pivot[1] === 0,
        "entities use explicit top-left/root coordinates",
      );
      integer(x, 0, level.pxWid, "entity x");
      integer(y, 0, level.pxHei, "entity y");
      const allowed: Record<string, string[]> = {
        Entry: ["ActorId"],
        Checkpoint: [],
        Spawn: ["ActorId"],
        Jump: ["ActorId", "DestinationX", "DestinationY", "Direction", "MaxTicks"],
        Drop: ["ActorId", "DestinationX", "DestinationY", "Direction", "MaxTicks"],
        Camera: [],
        KillBounds: [],
        Exit: [],
      };
      check(
        Object.hasOwn(allowed, entity.__identifier),
        `unsupported entity ${entity.__identifier}`,
      );
      check(
        fields.size === 1 + (allowed[entity.__identifier]?.length ?? 0) &&
          [...fields.keys()].every(
            (k) => k === "StableId" || allowed[entity.__identifier]?.includes(String(k)),
          ),
        "unexpected entity fields",
      );
      return {
        id,
        kind: entity.__identifier,
        x: pixels(x),
        y: pixels(y),
        w: pixels(entity.width),
        h: pixels(entity.height),
        number,
      };
    })
    .sort((a, b) => a.id - b.id);
  unique(entities, (e) => e.id, "stable entity ID");
  const one = (kind: string) => {
    const values = entities.filter((e) => e.kind === kind);
    check(values.length === 1 && values[0], `expected one ${kind}`);
    return values[0];
  };
  const entry = one("Entry"),
    checkpoint = one("Checkpoint"),
    cameraEntity = one("Camera"),
    killEntity = one("KillBounds"),
    exitEntity = one("Exit");
  const rect = (e: typeof entry): Rect => ({ x: e.x, y: e.y, w: e.w, h: e.h });
  const camera = rect(cameraEntity),
    killBounds = rect(killEntity),
    exit = rect(exitEntity);
  for (const area of [camera, killBounds, exit]) check(area.w > 0 && area.h > 0, "empty region");
  check(within(camera, killBounds) && within(exit, camera), "camera/exit bounds");
  check(
    checkpoint.x >= exit.x &&
      checkpoint.x <= exit.x + exit.w &&
      checkpoint.y >= exit.y &&
      checkpoint.y <= exit.y + exit.h,
    "checkpoint must meet exit region",
  );
  check(
    !terrain.some((t) => t.kind === "solid" && overlaps(exit, t.rect)),
    "exit obstructed by solid terrain",
  );
  const shapes = new Map(definitions.shapes.map((s) => [s.id, s]));
  const actors = new Map(definitions.actors.map((a) => [a.id, a]));
  const surfaces = new Map<number, WalkSurface>();
  const surfaceFor = (actorId: number) => {
    const def = actors.get(actorId),
      shape = def && shapes.get(def.standingShapeId);
    check(def?.locomotion === "grounded" && shape, "unsupported actor locomotion");
    let surface = surfaces.get(actorId);
    if (!surface) {
      surface = new WalkSurface(terrain, shape, 1);
      surfaces.set(actorId, surface);
    }
    return { definition: def, surface };
  };
  const spawn = (id: number, actorId: number, x: number, y: number, facing: -1 | 1): FootActor => {
    const { definition, surface } = surfaceFor(actorId),
      support = surface.locate(x, y, facing, 1);
    check(support, `unsupported/obstructed grounded spawn ${id}`);
    const shape = shapes.get(definition.standingShapeId);
    check(
      shape && within(worldRect({ x, y }, shape.rect, facing), killBounds),
      "spawn outside kill bounds",
    );
    return {
      body: {
        id,
        x,
        y,
        vx: 0,
        vy: 0,
        remainderX: 0,
        remainderY: 0,
        shapeId: definition.standingShapeId,
        supportId: support.supportIds[0] ?? null,
        grounded: true,
        contacts: [],
      },
      life: "alive",
      locomotion: "grounded",
      action: {
        kind: "ready",
        actionInstanceId: 0,
        stateStartTick: 0,
        definitionId: 0,
        nextMarkerIndex: 0,
      },
      facing,
      aim: 0,
      jumpBufferTicks: 0,
      coyoteTicks: ARCADE.coyoteTicks,
      ignoredSupportId: null,
      ignoredSupportTicks: 0,
      vehicleId: null,
      geometryRevision: 1,
    };
  };
  const actorId = entry.number("ActorId");
  const initial = spawn(entry.id, actorId, entry.x, entry.y, 1);
  spawn(checkpoint.id, actorId, checkpoint.x, checkpoint.y, 1);
  const spawns = entities
    .filter((e) => e.kind === "Spawn")
    .map((e) => ({
      actorId: e.number("ActorId"),
      actor: spawn(e.id, e.number("ActorId"), e.x, e.y, 1),
    }));
  check(
    entities.filter((e) => e.kind === "Jump" || e.kind === "Drop").length <= 256,
    "link budget",
  );
  const links = entities
    .filter((e) => e.kind === "Jump" || e.kind === "Drop")
    .map((e) => {
      const actorId = e.number("ActorId"),
        direction = e.number("Direction");
      check(direction === -1 || direction === 1, "link direction");
      const actor = spawn(e.id, actorId, e.x, e.y, direction),
        { definition, surface } = surfaceFor(actorId);
      const source = surface.locate(e.x, e.y, direction, 1),
        dx = pixels(e.number("DestinationX")),
        dy = pixels(e.number("DestinationY"));
      const destination = surface.locate(dx, dy, direction, 1);
      check(source && destination, "unsupported link endpoint");
      const compiled = new CompiledTraversal(
        {
          id: e.id,
          kind: e.kind === "Jump" ? "jump" : "drop",
          sourceSpanId: source.id,
          sourceX: e.x,
          destinationSpanId: destination.id,
          destinationMinX: dx,
          destinationMaxX: dx,
          direction,
          maxTicks: e.number("MaxTicks"),
        },
        actor,
        definition,
        shapes,
        terrain,
        surface,
      );
      return { actorId, actor, compiled };
    });
  check(links.length <= 256, "link budget");
  const { definition, surface } = surfaceFor(actorId);
  const graph = new NavigationGraph(
    surface,
    definition,
    links.filter((l) => l.actorId === actorId).map((l) => l.compiled),
  );
  const goal = { x: checkpoint.x, y: checkpoint.y, facing: 1 as const };
  const route = graph.route(
    { x: initial.body.x, y: initial.body.y, facing: initial.facing },
    goal,
    1,
  );
  check(route.status === "route", "checkpoint route unreachable");
  const follower = new RouteFollower(graph, route, shapes);
  let current: FootActor = initial,
    cursor = follower.begin(current, 0);
  const grid = new CollisionGrid(terrain);
  for (let tick = 1; tick <= route.costTicks; tick++) {
    const frame = { tick, geometryRevision: 1 };
    const progress = follower.step(current, cursor, new CollisionIndex(grid, [], frame), frame);
    check(
      progress.status === "active" || progress.status === "arrived",
      "checkpoint route does not execute",
    );
    current = progress.actor;
    const activeShape = shapes.get(current.body.shapeId);
    check(
      activeShape && within(worldRect(current.body, activeShape.rect, current.facing), killBounds),
      "checkpoint route leaves kill bounds",
    );
    if (progress.cursor) cursor = progress.cursor;
    else check(tick === route.costTicks, "early checkpoint arrival");
  }
  const { terrain: _terrain, encounters: _encounters, ...library } = structuredClone(definitions);
  for (const values of Object.values(library)) {
    if (Array.isArray(values))
      values.sort((a, b) =>
        typeof a.id === "number" && typeof b.id === "number"
          ? a.id - b.id
          : String(a.id) < String(b.id)
            ? -1
            : String(a.id) > String(b.id)
              ? 1
              : 0,
      );
  }
  const gameplay = {
    format: 1,
    simulationHz: 60,
    dimensions: { w: pixels(level.pxWid), h: pixels(level.pxHei) },
    definitions: library,
    terrain,
    camera,
    killBounds,
    exit,
    entry: { actorId, actor: initial },
    checkpoint: goal,
    spawns,
    links: links.map((l) => ({
      actorId: l.actorId,
      actor: l.actor,
      definition: l.compiled.definition,
    })),
    route,
  };
  const presentation = {
    format: 1,
    tileset: {
      id: visible.__tilesetDefUid,
      path: tileset.relPath,
      width: tileset.pxWid,
      height: tileset.pxHei,
      cell,
    },
    tiles: graphics,
  };
  return {
    format: 1,
    compiler: "edgefall-ldtk-1",
    editorSchema: "1.5.3",
    contentHash: hash(gameplay),
    graphicsHash: hash(presentation),
    gameplay,
    presentation,
  };
}
