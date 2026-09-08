import { describe, expect, it } from "vitest";
import {
  HARBOR_GRENADIER,
  createGrenadierState,
  stepGrenadier,
  validateGrenadierState,
} from "../src/game/actors/grenadier.js";
import type { GroundedEnemy } from "../src/game/actors/grounded.js";
import { stateHash } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { COMBAT_SHAPES, GRENADE_PROFILE } from "../src/game/labs/combat-content.js";
import { footActor, footTerrain } from "../src/game/labs/foot-fixture.js";

const grenadeShape = COMBAT_SHAPES.get(GRENADE_PROFILE.bodyShapeId);
if (!grenadeShape) throw new Error("Missing grenade shape");
const shape = grenadeShape;
const floor = [footTerrain(100, -400, 200, 800, 32)];
function fixture() {
  const body = footActor(200, 200).body;
  body.id = 20;
  const enemy: GroundedEnemy = {
    body,
    facing: -1,
    geometryRevision: 1,
    life: "alive",
    removalReason: null,
    turns: 0,
  };
  return { enemy, player: footActor(80, 200), state: createGrenadierState(), nextActionId: 1 };
}

describe("grenadier committed throw", () => {
  it("locks target, direction and arc through startup and emits one release after 36 ticks", () => {
    const value = fixture(),
      other = footActor(320, 200);
    other.playerId = 2;
    other.slot = 1;
    let state = value.state,
      next = 1,
      releases = 0;
    for (let tick = 1; tick <= 108; tick++) {
      if (tick === 2) value.player.body.x = pixels(350);
      const prior = stateHash(state);
      const result = stepGrenadier(
        state,
        value.enemy,
        [other, value.player],
        true,
        tick,
        next,
        shape,
        floor,
      );
      expect(stateHash(state)).toBe(prior);
      state = result.state;
      next = result.nextActionId;
      expect(state.targetId).toBe(1);
      expect(result.facing).toBe(-1);
      expect(result.speed).toBe(0);
      if (result.release) {
        expect(tick).toBe(37);
        expect(result.release).toMatchObject({
          ownerId: 20,
          actionInstanceId: 1,
          releaseTick: 37,
          facing: -1,
          velocity: { x: -pixels(3), y: HARBOR_GRENADIER.launchY },
        });
        releases++;
      }
      validateGrenadierState(state, tick, next, [other, value.player]);
    }
    expect(releases).toBe(1);
    expect(next).toBe(2);
  });

  it("cannot begin through a low ceiling or a wall at its hand", () => {
    const value = fixture();
    for (const blocker of [footTerrain(101, 160, 150, 80, 12), footTerrain(101, 185, 160, 4, 32)]) {
      const result = stepGrenadier(value.state, value.enemy, [value.player], true, 1, 1, shape, [
        ...floor,
        blocker,
      ]);
      expect(result.state.phase).toBe("patrol");
      expect(result.nextActionId).toBe(1);
      expect(result.release).toBeNull();
    }
  });

  it("consumes a blocked release and recovers without retrying that grenade", () => {
    const value = fixture();
    let state = value.state,
      next = 1,
      releases = 0;
    for (let tick = 1; tick <= 108; tick++) {
      const terrain = tick === 37 ? [...floor, footTerrain(101, 160, 150, 80, 12)] : floor;
      const result = stepGrenadier(
        state,
        value.enemy,
        [value.player],
        true,
        tick,
        next,
        shape,
        terrain,
      );
      state = result.state;
      next = result.nextActionId;
      releases += Number(result.release !== null);
    }
    expect(releases).toBe(0);
    expect(state).toMatchObject({ phase: "recovery", phaseStartTick: 37, released: true });
  });

  it.each([2, 36, 37])(
    "death before release at tick %i cancels all future markers",
    (deathTick) => {
      const value = fixture();
      let state = value.state,
        next = 1;
      for (let tick = 1; tick <= 150; tick++) {
        if (tick === deathTick) value.enemy.life = "removed";
        const result = stepGrenadier(
          state,
          value.enemy,
          [value.player],
          true,
          tick,
          next,
          shape,
          floor,
        );
        state = result.state;
        next = result.nextActionId;
        expect(result.release).toBeNull();
      }
      expect(state).toMatchObject({ phase: "dead", phaseStartTick: deathTick, targetId: null });
    },
  );

  it("retreats at close range without attacking, and ignores protected or sleeping targets", () => {
    const value = fixture();
    value.player.body.x = pixels(175);
    expect(
      stepGrenadier(value.state, value.enemy, [value.player], true, 1, 1, shape, floor),
    ).toMatchObject({
      facing: 1,
      speed: pixels(1),
      release: null,
      state: { phase: "retreat", phaseStartTick: 1 },
    });
    expect(
      stepGrenadier(value.state, value.enemy, [value.player], false, 1, 1, shape, floor).release,
    ).toBeNull();
    value.player.invulnerableTicks = 120;
    expect(
      stepGrenadier(value.state, value.enemy, [value.player], true, 1, 1, shape, floor).state.phase,
    ).toBe("patrol");
  });

  it("rejects reused boundaries and forged consumed or mistimed continuations", () => {
    const value = fixture();
    const started = stepGrenadier(
      value.state,
      value.enemy,
      [value.player],
      true,
      1,
      1,
      shape,
      floor,
    );
    expect(() =>
      stepGrenadier(started.state, value.enemy, [value.player], true, 1, 2, shape, floor),
    ).toThrow("boundary");
    expect(() =>
      validateGrenadierState({ ...started.state, released: true }, 1, 2, [value.player]),
    ).toThrow("continuation");
    expect(() =>
      validateGrenadierState({ ...started.state, tick: 37 }, 37, 2, [value.player]),
    ).toThrow("continuation");
    expect(() =>
      stepGrenadier(started.state, value.enemy, [value.player], false, 2, 2, shape, floor),
    ).toThrow("deactivate");
  });
});
