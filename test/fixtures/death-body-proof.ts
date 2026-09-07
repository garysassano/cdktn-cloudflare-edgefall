import {
  type PlayerLifeContext,
  damagePlayer,
  stepPlayerLife,
} from "../../src/game/campaign/life.js";
import { stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import {
  FOOT_DEFINITION,
  FOOT_FLOOR,
  FOOT_SHAPES,
  footActor,
  footTerrain,
} from "../../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";
import type { SweepTarget } from "../../src/game/physics/sweep.js";
import type { ControlledActor } from "../../src/game/state.js";

export function deathContext(
  tick: number,
  fixed = [FOOT_FLOOR],
  moving: SweepTarget[] = [],
): PlayerLifeContext {
  const shape = FOOT_SHAPES.get(1);
  if (!shape || !FOOT_DEFINITION) throw new Error("Missing death physics content");
  const frame = { tick, geometryRevision: 1 };
  return {
    shape,
    definition: FOOT_DEFINITION,
    shapes: FOOT_SHAPES,
    // Block entry deliberately so each collision case can finish independently of the death timer.
    anchors: [{ x: pixels(500), y: 0 }],
    index: new CollisionIndex(new CollisionGrid(fixed), moving, frame),
    frame,
    fallBoundary: pixels(100),
  };
}
export function airbornePlayer(x = 0, y = -8, vx = 2, vy = -1): ControlledActor {
  const actor = footActor(x, y);
  actor.locomotion = "airborne";
  Object.assign(actor.body, { vx: pixels(vx), vy: pixels(vy), grounded: false, supportId: null });
  return actor;
}
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Death body proof: ${reason}`);
}
function record(actor: ControlledActor, tick: number) {
  return {
    tick,
    life: actor.life,
    bodyPresence: actor.bodyPresence,
    lives: actor.lives,
    since: actor.lifeStartTick,
    body: actor.body,
  };
}
/** Passive floor/one-way, carry, support loss, crush and void cases use the real shared solver. */
export function deathBodyProof() {
  const cases = [];
  for (const kind of ["solid", "one-way"] as const) {
    const initial = airbornePlayer();
    let actor = damagePlayer(initial, 0, 1, "classic").actor;
    check(actor.body.vx === pixels(2) && actor.body.vy === -256, "hit erased airborne momentum");
    const trace = [record(actor, 0)];
    for (let tick = 1; tick <= 40; tick++) {
      actor = stepPlayerLife(
        actor,
        tick,
        "classic",
        deathContext(tick, [{ ...FOOT_FLOOR, kind }]),
      ).actor;
      trace.push(record(actor, tick));
    }
    const landed = trace.find((sample) => sample.body.grounded);
    check(landed && landed.tick > 1 && landed.tick < 30, "did not land before the entry deadline");
    check(trace[1] && trace[1].body.y < initial.body.y, "upward velocity was lost");
    check(actor.body.y === 0 && actor.body.vx === 0 && actor.body.vy === 0, "did not settle");
    check(
      actor.life === "death" && actor.lives === 2 && actor.lifeStartTick === 0,
      "blocked entry spent a life or reset the clock",
    );
    cases.push({ name: kind, landedTick: landed.tick, trace, hash: stateHash(trace) });
  }
  {
    let actor = damagePlayer(footActor(), 0, 1, "classic").actor;
    const trace = [record(actor, 0)];
    for (let tick = 1; tick <= 10; tick++) {
      const platform = {
        ...footTerrain(100, tick - 1, -(tick - 1), 80, 8),
        delta: { x: pixels(1), y: pixels(-1) },
      };
      actor = stepPlayerLife(actor, tick, "classic", deathContext(tick, [], [platform])).actor;
      check(
        actor.body.x === pixels(tick) && actor.body.y === pixels(-tick) && actor.body.grounded,
        "platform carry diverged",
      );
      trace.push(record(actor, tick));
    }
    actor = stepPlayerLife(actor, 11, "classic", deathContext(11, [])).actor;
    check(
      !actor.body.grounded && actor.body.y > pixels(-10),
      "removed support left corpse suspended",
    );
    trace.push(record(actor, 11));
    cases.push({ name: "platform-and-support-loss", landedTick: 0, trace, hash: stateHash(trace) });
  }
  {
    const actor = damagePlayer(footActor(), 0, 1, "classic").actor;
    const ceiling = footTerrain(101, -100, -40, 200, 5);
    const lift = {
      ...footTerrain(100, -100, 0, 200, 8),
      delta: { x: 0, y: pixels(-4) },
    };
    const result = stepPlayerLife(actor, 1, "classic", deathContext(1, [ceiling], [lift]));
    check(
      result.actor.bodyPresence === "removed" && result.actor.lives === 2 && result.notice === null,
      "crush stalled or spent another life",
    );
    check(
      result.actor.body.x === actor.body.x && result.actor.body.y === actor.body.y,
      "crush committed unresolved position",
    );
    const trace = [record(actor, 0), record(result.actor, 1)];
    cases.push({ name: "crush", landedTick: null, trace, hash: stateHash(trace) });
  }
  {
    let actor = damagePlayer(airbornePlayer(0, 99, 2, 8), 0, 1, "classic").actor;
    const trace = [record(actor, 0)];
    for (let tick = 1; tick <= 90; tick++) {
      const result = stepPlayerLife(actor, tick, "classic", deathContext(tick, []));
      check(result.notice === null, "blocked void entry emitted life event");
      actor = damagePlayer(result.actor, tick, 1, "classic", "fall").actor;
      trace.push(record(actor, tick));
    }
    check(
      actor.bodyPresence === "removed" && actor.lives === 2 && actor.lifeStartTick === 0,
      "void changed life accounting",
    );
    check(stateHash(actor.body) === stateHash(trace[1]?.body), "removed body kept integrating");
    const entry = deathContext(91);
    entry.anchors = [{ x: 0, y: 0 }];
    actor = stepPlayerLife(actor, 91, "classic", entry).actor;
    check(
      actor.life === "respawning" && actor.bodyPresence === "present" && actor.lives === 2,
      "removed corpse blocked a safe entry",
    );
    trace.push(record(actor, 91));
    cases.push({ name: "void-and-entry-retry", landedTick: null, trace, hash: stateHash(trace) });
  }
  return { cases, hash: stateHash(cases) };
}
