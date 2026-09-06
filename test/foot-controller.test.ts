import { describe, expect, it } from "vitest";
import { stepFootController } from "../src/game/controller/foot.js";
import { MAX_POSITION, MAX_SHAPE, pixels, randomStep } from "../src/game/core/numeric.js";
import { type AppliedInput, Edge, Held } from "../src/game/input/types.js";
import {
  blockingShapes,
  stepBody,
  tryBodyShape,
  worldRect,
  worldSocket,
} from "../src/game/physics/body.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import { sweepAabb } from "../src/game/physics/sweep.js";
import type { ControlledActor } from "../src/game/state.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import { InputStream } from "../src/shared/protocol/input-stream.js";
import { controllerBoundaryProof, controllerProof } from "./fixtures/controller-proof.js";
import {
  FOOT_DEFINITION,
  FOOT_FLOOR,
  FOOT_SHAPES,
  footActor,
  footTerrain,
} from "./fixtures/foot-fixture.js";

function index(terrain: SweepTarget[] = [FOOT_FLOOR], tick = 1) {
  return new CollisionIndex(
    new CollisionGrid(terrain.filter((target) => target.delta.x === 0 && target.delta.y === 0)),
    terrain.filter((target) => target.delta.x !== 0 || target.delta.y !== 0),
    { geometryRevision: 1, tick },
  );
}
function step(
  actor: ControlledActor,
  held = 0,
  jumpPressed = false,
  terrain = [FOOT_FLOOR],
  tick = 1,
) {
  if (!FOOT_DEFINITION) throw new Error("Missing actor");
  const result = stepFootController(
    actor,
    { held, jumpPressed },
    FOOT_DEFINITION,
    FOOT_SHAPES,
    index(terrain, tick),
    { geometryRevision: 1, tick },
  );
  if (result.status !== "complete") throw new Error(`Controller failed: ${JSON.stringify(result)}`);
  return result;
}
function shape(id: number) {
  const result = FOOT_SHAPES.get(id);
  if (!result) throw new Error("Missing shape");
  return result;
}

describe("root shapes and sockets", () => {
  it("reflects asymmetric geometry and sockets about the same root without changing feet", () => {
    const local = { x: pixels(-3), y: pixels(-20), w: pixels(10), h: pixels(20) };
    expect(worldRect({ x: pixels(100), y: pixels(50) }, local, 1)).toEqual({
      x: pixels(97),
      y: pixels(30),
      w: pixels(10),
      h: pixels(20),
    });
    expect(worldRect({ x: pixels(100), y: pixels(50) }, local, -1)).toEqual({
      x: pixels(93),
      y: pixels(30),
      w: pixels(10),
      h: pixels(20),
    });
    expect(worldSocket({ x: 100, y: 50 }, { x: 15, y: -23 }, -1)).toEqual({ x: 85, y: 27 });
  });
  it("rejects local far-edge overflow, world overflow and a changed feet anchor", () => {
    expect(() => worldRect({ x: 0, y: 0 }, { x: MAX_SHAPE, y: 0, w: 1, h: 1 }, -1)).toThrow();
    expect(() => worldRect({ x: MAX_POSITION, y: 0 }, { x: 0, y: 0, w: 1, h: 1 }, 1)).toThrow();
    const frame = index();
    expect(() =>
      tryBodyShape(
        footActor().body,
        shape(1),
        { id: 9, rect: { x: 0, y: 0, w: 1, h: 1 } },
        1,
        1,
        frame,
        frame.frame,
      ),
    ).toThrow(/feet/);
  });
  it("keeps crouch beneath a solid ceiling, permits one-way head overlap and checks end geometry", () => {
    const actor = footActor();
    actor.body.shapeId = 2;
    const roof = footTerrain(101, -20, -40, 40, 15);
    const frame = index([FOOT_FLOOR, roof]);
    expect(tryBodyShape(actor.body, shape(2), shape(1), 1, 1, frame, frame.frame)).toMatchObject({
      accepted: false,
      blockedBy: [101],
    });
    const oneWay = index([{ ...roof, kind: "one-way" }]);
    expect(blockingShapes(actor.body, shape(1).rect, 1, oneWay, oneWay.frame)).toEqual([]);
    const departing = index([{ ...roof, delta: { x: 0, y: pixels(-20) } }]);
    expect(blockingShapes(actor.body, shape(1).rect, 1, departing, departing.frame, "end")).toEqual(
      [],
    );
  });
  it("maps successful displacement back to the root and exposes only final contact representatives", () => {
    const actor = footActor(0, -10);
    actor.body.vy = pixels(20);
    actor.body.supportId = null;
    actor.body.grounded = false;
    const geometry = [FOOT_FLOOR, ...[101, 102, 103, 104].map((id) => ({ ...FOOT_FLOOR, id }))];
    const frame = index(geometry);
    const result = stepBody(actor.body, shape(1), 1, frame, { frame: frame.frame });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("Movement failed");
    expect(result.body).toMatchObject({ x: 0, y: 0, grounded: true, supportId: 100 });
    expect(result.movement.contacts).toHaveLength(5);
    expect(result.body.contacts).toEqual([
      { otherId: 100, normalX: 0, normalY: -1, toiNumerator: 1, toiDenominator: 1, kind: "solid" },
    ]);
  });
  it("does not return a body that callers could accept after failed movement", () => {
    const actor = footActor();
    const frame = index([footTerrain(101, -100, -100, 200, 200)]);
    const result = stepBody(actor.body, shape(1), 1, frame, { frame: frame.frame });
    expect(result).toMatchObject({ status: "failed", reason: "initial-overlap" });
    expect("body" in result).toBe(false);
  });
});

describe("classic foot controller", () => {
  it("dispatches an admitted jump once with neutral held state and a duplicate packet", () => {
    const stream = new InputStream({
      runEpoch: 1,
      connectionEpoch: 2,
      playerId: 1,
      controlEpoch: 1,
      baselineServerTick: 0,
    });
    const bytes = encodeInputBatch({
      runEpoch: 1,
      connectionEpoch: 2,
      packetSequence: 1,
      snapshotAck: 0,
      eventAck: 0,
      commands: [
        {
          sequence: 1,
          clientTick: 0,
          controlEpoch: 1,
          held: 0,
          aim: 0,
          edges: [{ kind: Edge.Jump, id: 1 }],
        },
      ],
    });
    let actor = footActor();
    let jumps = 0;
    stream.receive(bytes, 0, 0);
    const apply = (input: AppliedInput) => {
      const result = step(
        actor,
        input.command.held,
        input.command.edges.some((edge) => edge.kind === Edge.Jump),
        [FOOT_FLOOR],
        input.serverTick,
      );
      actor = result.actor;
      jumps += result.events.filter((event) => event.kind === "jump").length;
      return input.command.edges.map((edge) => ({ ...edge, outcome: "applied" as const }));
    };
    expect(stream.processTick(1, 16, apply).edgeResults).toEqual([
      { kind: Edge.Jump, id: 1, outcome: "applied" },
    ]);
    expect(stream.receive(bytes, 17, 1).duplicate).toBe(true);
    expect(stream.processTick(2, 32, apply).edgeResults).toEqual([]);
    expect(jumps).toBe(1);
    expect(stream.acknowledgment.processedEdgeIds[0]).toBe(1);
  });
  it("rejects an asymmetric facing change into a wall without moving the root to make it fit", () => {
    if (!FOOT_DEFINITION) throw new Error("Missing definition");
    const shapes = new Map([
      [9, { id: 9, rect: { x: pixels(-2), y: pixels(-34), w: pixels(12), h: pixels(34) } }],
      [10, { id: 10, rect: { x: pixels(-2), y: pixels(-20), w: pixels(12), h: pixels(20) } }],
    ]);
    const actor = footActor();
    actor.body.shapeId = 9;
    const geometry = index([FOOT_FLOOR, footTerrain(101, -10, -40, 7, 40)]);
    const result = stepFootController(
      actor,
      { held: Held.Left, jumpPressed: false },
      { ...FOOT_DEFINITION, standingShapeId: 9, crouchedShapeId: 10 },
      shapes,
      geometry,
      geometry.frame,
    );
    expect(result).toMatchObject({
      status: "complete",
      actor: { facing: 1, body: { x: pixels(-1) } },
      physics: { movement: { correction: { x: 0, y: 0 } } },
    });
  });
  it("accepts landing on the fifth buffered tick but not the sixth", () => {
    for (const [height, expectedJumps] of [
      [800, 1],
      [900, 0],
    ] as const) {
      let actor = footActor();
      actor.body.y = -height;
      actor.body.grounded = false;
      actor.body.supportId = null;
      actor.coyoteTicks = 0;
      let jumps = 0;
      for (let tick = 1; tick <= 6; tick++) {
        const result = step(actor, 0, tick === 1, [FOOT_FLOOR], tick);
        actor = result.actor;
        jumps += result.events.filter((event) => event.kind === "jump").length;
      }
      expect(jumps, `height ${height}`).toBe(expectedJumps);
    }
  });
  it("gives direct and landing-buffered jumps the same displacement sequence", () => {
    const falling = footActor(0, -1);
    falling.body.supportId = null;
    falling.body.grounded = false;
    falling.coyoteTicks = 0;
    falling.body.vy = 300;
    let buffered = step(falling, 0, true).actor;
    let direct = footActor();
    for (let tick = 0; tick < 80; tick++) {
      direct = step(direct, 0, tick === 0).actor;
      buffered = step(buffered).actor;
      expect([buffered.body.y, buffered.body.vy, buffered.body.grounded], `tick ${tick}`).toEqual([
        direct.body.y,
        direct.body.vy,
        direct.body.grounded,
      ]);
    }
  });
  it("crouches on landing and gives a buffered down+jump drop priority over jumping", () => {
    const falling = footActor(0, -1);
    falling.body.supportId = null;
    falling.body.grounded = false;
    falling.coyoteTicks = 0;
    falling.body.vy = 300;
    expect(step(falling, Held.Down).actor).toMatchObject({
      locomotion: "crouched",
      body: { shapeId: 2, grounded: true },
    });
    const result = step(falling, Held.Down, true, [{ ...FOOT_FLOOR, kind: "one-way" }]);
    expect(result.events.map((event) => event.kind)).toEqual(["land", "drop"]);
    expect(result.actor).toMatchObject({
      ignoredSupportId: 100,
      ignoredSupportTicks: 12,
      body: { grounded: false, vy: 0 },
    });
  });
  it("restores on-foot controller state from a v3 baseline without changing later ticks", () => {
    expect(controllerProof(599)).toEqual(controllerProof());
  });
  it("covers blocked stand-up, end-phase clearance and topology removal in portable cases", () => {
    const cases = new Map(
      controllerBoundaryProof().cases.map((entry) => [entry.name, entry.result]),
    );
    expect(cases.get("blocked-stand")?.actor.locomotion).toBe("crouched");
    expect(cases.get("end-clearance-jump")?.actor.body).toMatchObject({
      shapeId: 1,
      y: 0,
      vy: -1430,
      grounded: false,
    });
    expect(cases.get("buffered-airborne")?.actor.body.y).toBe(-1375);
    expect(cases.get("removed-support")?.actor.body).toMatchObject({
      x: pixels(2),
      y: 55,
      supportId: null,
      grounded: false,
    });
  });
  it("runs immediately, stops on release, reverses in air and cancels opposing directions", () => {
    const original = footActor();
    const moved = step(original, Held.Right).actor;
    expect(moved.body).toMatchObject({ x: 768, vx: 768, grounded: true });
    expect(step(moved).actor.body.x).toBe(768);
    expect(step(moved, Held.Left | Held.Right).actor).toMatchObject({
      facing: 1,
      body: { x: 768, vx: 0 },
    });
    const jumping = step(moved, Held.Right, true).actor;
    expect(step(jumping, Held.Left).actor).toMatchObject({ facing: -1, body: { vx: -768 } });
    expect(original).toEqual(footActor());
  });
  it("crouches stationary, refuses stand-up under a ceiling and derives ground/air aim", () => {
    const crouch = step(footActor(), Held.Down | Held.Right).actor;
    expect(crouch).toMatchObject({
      locomotion: "crouched",
      aim: 0,
      body: { x: 0, y: 0, shapeId: 2, vx: 0 },
    });
    const roof = footTerrain(101, -20, -40, 40, 15);
    expect(step(crouch, 0, false, [FOOT_FLOOR, roof]).actor).toMatchObject({
      locomotion: "crouched",
      body: { shapeId: 2, y: 0 },
    });
    expect(step(crouch).actor).toMatchObject({
      locomotion: "grounded",
      body: { shapeId: 1, y: 0 },
    });
    expect(step(footActor(), Held.Up).actor.aim).toBe(1);
    const airborne = step(footActor(), 0, true).actor;
    expect(step(airborne, Held.Down).actor.aim).toBe(2);
  });
  it("launches one fixed-height jump and does not infer repeated jumps from held input", () => {
    let actor = step(footActor(), Held.Fire, true).actor;
    expect(actor.body).toMatchObject({ y: -1375, vy: -1375, grounded: false });
    let jumps = 1;
    let minimum = actor.body.y;
    for (let tick = 2; tick <= 100; tick++) {
      const result = step(actor, Held.Fire, false, [FOOT_FLOOR], tick);
      actor = result.actor;
      minimum = Math.min(minimum, actor.body.y);
      jumps += result.events.filter((event) => event.kind === "jump").length;
    }
    expect(jumps).toBe(1);
    expect(minimum).toBe(-17875);
    expect(actor.body).toMatchObject({ y: 0, grounded: true, vy: 0 });
  });
  it("retains exactly four future coyote ticks after walking off a ledge", () => {
    const ledge = footTerrain(100, -20, 0, 20, 16);
    const first = step(footActor(6, 0), Held.Right, false, [ledge]).actor;
    expect(first.body.grounded).toBe(false);
    expect(first.coyoteTicks).toBe(4);
    let actor = first;
    for (let tick = 0; tick < 3; tick++) actor = step(actor, Held.Right, false, [ledge]).actor;
    expect(actor.coyoteTicks).toBe(1);
    expect(
      step(actor, Held.Right, true, [ledge]).events.some((event) => event.kind === "jump"),
    ).toBe(true);
    actor = step(actor, Held.Right, false, [ledge]).actor;
    expect(actor.coyoteTicks).toBe(0);
    expect(
      step(actor, Held.Right, true, [ledge]).events.some((event) => event.kind === "jump"),
    ).toBe(false);
  });
  it("consumes a buffered jump at landing without advancing the world twice", () => {
    const actor = footActor(0, -1);
    actor.body.supportId = null;
    actor.body.grounded = false;
    actor.coyoteTicks = 0;
    actor.body.vy = 300;
    const result = step(actor, 0, true);
    expect(result.events.map((event) => event.kind)).toEqual(["land", "jump"]);
    expect(result.actor.body).toMatchObject({ y: 0, vy: -1430, grounded: false });
    expect(result.actor.jumpBufferTicks).toBe(0);
    expect(step(result.actor).actor.body.y).toBe(-1375);
  });
  it("expires an unconsumed jump after five attempted ticks", () => {
    let actor = footActor(0, -200);
    actor.body.supportId = null;
    actor.body.grounded = false;
    actor.coyoteTicks = 0;
    actor = step(actor, 0, true).actor;
    expect(actor.jumpBufferTicks).toBe(4);
    for (let i = 0; i < 4; i++) actor = step(actor).actor;
    expect(actor.jumpBufferTicks).toBe(0);
  });
  it("drops only through its selected one-way support and lands on the lower platform", () => {
    const upper = { ...FOOT_FLOOR, kind: "one-way" as const };
    const lower = footTerrain(101, -200, 20, 400, 8, "one-way");
    let result = step(footActor(), Held.Down, true, [upper, lower]);
    expect(result.events.map((event) => event.kind)).toEqual(["drop"]);
    expect(result.actor).toMatchObject({
      ignoredSupportId: 100,
      ignoredSupportTicks: 11,
      body: { grounded: false, vy: 55 },
    });
    for (let tick = 2; tick <= 30; tick++)
      result = step(result.actor, Held.Down, false, [upper, lower], tick);
    expect(result.actor.body).toMatchObject({ y: pixels(20), supportId: 101, grounded: true });
    expect(result.actor.ignoredSupportId).toBeNull();
  });
  it("carries riders once, releases them for jumping and falls when support is removed", () => {
    const moving = { ...FOOT_FLOOR, delta: { x: pixels(2), y: pixels(-1) } };
    expect(step(footActor(), 0, false, [moving]).actor.body).toMatchObject({
      x: pixels(2),
      y: pixels(-1),
      vy: 0,
    });
    expect(step(footActor(), 0, true, [moving]).actor.body).toMatchObject({
      x: 0,
      y: -1375,
      grounded: false,
    });
    expect(step(footActor(), 0, false, []).actor.body).toMatchObject({
      y: 55,
      grounded: false,
      supportId: null,
    });
  });
  it("leaves seat/death control to their owners, blocks jump during hurt and preserves knockback", () => {
    if (!FOOT_DEFINITION) throw new Error("Missing definition");
    const dead = footActor();
    dead.life = "death";
    expect(
      stepFootController(
        dead,
        { held: Held.Right, jumpPressed: true },
        FOOT_DEFINITION,
        FOOT_SHAPES,
        index(),
        { geometryRevision: 1, tick: 1 },
      ).status,
    ).toBe("inactive");
    const hurt = footActor();
    hurt.action.kind = "hurt";
    hurt.body.vx = -300;
    expect(step(hurt, Held.Right, true)).toMatchObject({
      jumpRequest: "unavailable",
      actor: { body: { x: -300, vx: -300 }, jumpBufferTicks: 0 },
    });
  });
  it("rejects mismatched geometry and unspecified motion remainder policies", () => {
    const bad = footActor();
    bad.geometryRevision = 2;
    expect(() => step(bad)).toThrow(/revision/);
    bad.geometryRevision = 1;
    bad.body.remainderX = 1;
    expect(() => step(bad)).toThrow(/remainder/);
  });
});

it("keeps 100 seeded controller routes nonpenetrating and preserves replay under geometry reordering", () => {
  const geometry = [
    FOOT_FLOOR,
    footTerrain(102, -210, -160, 10, 176),
    footTerrain(103, 200, -160, 10, 176),
    footTerrain(101, -60, -30, 120, 8, "one-way"),
  ];
  for (let seed = 1; seed <= 100; seed++) {
    let rng = seed;
    let actor = footActor();
    for (let tick = 1; tick <= 120; tick++) {
      rng = randomStep(rng);
      const held =
        [0, Held.Left, Held.Right, Held.Down, Held.Up, Held.Left | Held.Right][rng % 6] ?? 0;
      const result = step(actor, held, rng % 17 === 0, geometry, tick);
      expect(result, `seed ${seed}, tick ${tick}`).toEqual(
        step(actor, held, rng % 17 === 0, [...geometry].reverse(), tick),
      );
      actor = result.actor;
      const rect = worldRect(actor.body, shape(actor.body.shapeId).rect, actor.facing);
      for (const target of geometry.filter((target) => target.kind === "solid"))
        expect(
          sweepAabb(rect, { x: 0, y: 0 }, target.rect)?.kind,
          JSON.stringify({ seed, tick, actor }),
        ).not.toBe("overlap");
    }
  }
});
