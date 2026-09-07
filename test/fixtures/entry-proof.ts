import {
  type PlayerLifeContext,
  enterPlayer,
  stepPlayerLife,
} from "../../src/game/campaign/life.js";
import { stepFirearm } from "../../src/game/combat/firearm.js";
import { stepFootController } from "../../src/game/controller/foot.js";
import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import { Held } from "../../src/game/input/types.js";
import { COMBAT_CATALOG } from "../../src/game/labs/combat-content.js";
import { footActor, footTerrain } from "../../src/game/labs/foot-fixture.js";
import type { SweepTarget } from "../../src/game/physics/sweep.js";
import type { ControlledActor } from "../../src/game/state.js";
import { deathContext } from "./death-body-proof.js";

function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Entry physics proof: ${reason}`);
}
function context(
  tick: number,
  fixed: SweepTarget[],
  moving: SweepTarget[] = [],
): PlayerLifeContext {
  return { ...deathContext(tick, fixed, moving), anchors: [{ x: 0, y: 0 }] };
}
function sample(actor: ControlledActor, tick: number) {
  return {
    tick,
    life: actor.life,
    presence: actor.bodyPresence,
    since: actor.lifeStartTick,
    lives: actor.lives,
    protection: actor.invulnerableTicks,
    body: actor.body,
  };
}
function enter(ctx: PlayerLifeContext) {
  const actor = enterPlayer(footActor(), ctx.frame.tick, "classic", ctx);
  check(actor, "expected a safe anchor");
  return actor;
}
function carryContext(tick: number, kind: SweepTarget["kind"]) {
  const platform = {
    ...footTerrain(100, -100 + tick, -tick, 200, 8, kind),
    delta: { x: pixels(1), y: -pixels(1) },
  };
  return { ...context(tick, [], [platform]), anchors: [{ x: pixels(tick), y: -pixels(tick) }] };
}

/** Exact frame consumption, rejected input, unsafe entry and retry across serialization. */
export function entryPhysicsProof() {
  const carry = [];
  for (const kind of ["solid", "one-way"] as const) {
    let actor = enter(carryContext(0, kind));
    const trace = [sample(actor, 0)];
    check(actor.body.x === pixels(1) && actor.body.y === -pixels(1), "entry frame lost carry");
    for (let tick = 1; tick < 12; tick++) {
      const ctx = carryContext(tick, kind);
      actor = stepPlayerLife(actor, tick, "classic", ctx).actor;
      const controlled = stepFootController(
        actor,
        { held: Held.Right, jumpPressed: true },
        ctx.definition,
        ctx.shapes,
        ctx.index,
        ctx.frame,
      );
      check(controlled.status === "inactive", "entry accepted movement");
      const fired = stepFirearm(
        controlled.actor,
        { held: Held.Fire, firePressed: true },
        tick,
        1,
        COMBAT_CATALOG,
      );
      check(fired.outcome === "unavailable" && fired.markers.length === 0, "entry accepted fire");
      actor = fired.actor;
      check(
        actor.body.x === pixels(tick + 1) &&
          actor.body.y === -pixels(tick + 1) &&
          actor.body.grounded,
        "protected carry diverged",
      );
      check(
        actor.jumpBufferTicks === 0 && actor.weapon.shotOrdinal === 0,
        "entry queued rejected input",
      );
      trace.push(sample(actor, tick));
    }
    const ctx = carryContext(12, kind),
      ready = stepPlayerLife(actor, 12, "classic", ctx);
    check(ready.notice?.kind === "ready", "entry deadline moved");
    const idle = stepFootController(
      ready.actor,
      { held: 0, jumpPressed: false },
      ctx.definition,
      ctx.shapes,
      ctx.index,
      ctx.frame,
    );
    check(
      idle.status === "complete" &&
        idle.actor.body.x === pixels(13) &&
        idle.actor.body.y === -pixels(13),
      "ready frame carried twice",
    );
    const jump = stepFootController(
      ready.actor,
      { held: Held.Right, jumpPressed: true },
      ctx.definition,
      ctx.shapes,
      ctx.index,
      ctx.frame,
    );
    const vy = ctx.definition.jumpVelocity + ctx.definition.gravity;
    check(
      jump.status === "complete" &&
        jump.jumpRequest === "consumed" &&
        jump.actor.body.vy === vy &&
        jump.actor.body.x === pixels(12) + ctx.definition.runSpeed &&
        jump.actor.body.y === -pixels(12) + vy &&
        jump.actor.body.supportId === null,
      "first eligible jump did not consume exactly one frame",
    );
    const fire = stepFirearm(
      jump.actor,
      { held: Held.Fire, firePressed: true },
      12,
      1,
      COMBAT_CATALOG,
    );
    check(
      fire.outcome === "applied" &&
        fire.actor.weapon.shotOrdinal === 1 &&
        fire.markers.filter((marker) => marker.marker.kind === "spawn-attack").length === 1,
      "first eligible fire duplicated/lost",
    );
    carry.push({
      kind,
      trace,
      idle: sample(idle.actor, 12),
      jump: sample(fire.actor, 12),
      shots: fire.actor.weapon.shotOrdinal,
    });
  }
  const ceiling = footTerrain(101, -100, -40, 200, 5),
    floor = footTerrain(100, -100, 0, 200, 8);
  const lift = { ...floor, delta: { x: 0, y: -pixels(4) } };
  const unsafe = context(0, [ceiling], [lift]);
  const original = footActor(),
    before = canonical(original);
  check(
    enterPlayer(original, 0, "classic", unsafe) === null && canonical(original) === before,
    "unsafe initial sweep admitted or mutated player",
  );
  const fallback = enter({
    ...context(0, [ceiling, footTerrain(200, 140, 0, 100, 8)], [lift]),
    anchors: [
      { x: 0, y: 0 },
      { x: pixels(150), y: 0 },
    ],
  });
  check(
    fallback.body.x === pixels(150) && fallback.body.supportId === 200 && fallback.lives === 3,
    "unsafe priority anchor prevented safe fallback",
  );
  check(
    enterPlayer(original, 0, "classic", {
      ...context(0, [], [{ ...floor, delta: { x: 0, y: pixels(4) } }]),
      fallBoundary: pixels(2),
    }) === null,
    "entry ended below fall plane",
  );

  let actor = enter(context(0, [ceiling, floor]));
  const crushed = stepPlayerLife(actor, 1, "classic", {
    ...unsafe,
    frame: { tick: 1, geometryRevision: 1 },
    index: context(1, [ceiling], [lift]).index,
  });
  actor = crushed.actor;
  check(
    crushed.notice === null &&
      actor.life === "respawning" &&
      actor.bodyPresence === "removed" &&
      actor.lives === 3 &&
      actor.invulnerableTicks === 0 &&
      actor.lifeStartTick === 0,
    "protected crush spent a life or restarted entry",
  );
  const waiting = [sample(actor, 1)];
  for (let tick = 2; tick <= 30; tick++) {
    const ctx = context(tick, []);
    const restored = stepPlayerLife(JSON.parse(JSON.stringify(actor)), tick, "classic", ctx);
    const next = stepPlayerLife(actor, tick, "classic", ctx);
    check(
      canonical(next) === canonical(restored) &&
        next.notice === null &&
        next.actor.bodyPresence === "removed" &&
        next.actor.life === "respawning" &&
        next.actor.lives === 3,
      "waiting entry changed across reconstruction or became ready",
    );
    actor = next.actor;
    waiting.push(sample(actor, tick));
  }
  const retried = stepPlayerLife(actor, 31, "classic", context(31, [floor]));
  check(
    retried.notice?.kind === "respawn" &&
      retried.actor.bodyPresence === "present" &&
      retried.actor.lifeStartTick === 31 &&
      retried.actor.invulnerableTicks === 120,
    "safe retry did not restart protection/animation",
  );
  actor = retried.actor;
  for (let tick = 32; tick <= 43; tick++)
    actor = stepPlayerLife(actor, tick, "classic", context(tick, [floor])).actor;
  check(
    actor.life === "alive" && actor.lifeStartTick === 43 && actor.lives === 3,
    "retry deadline/accounting diverged",
  );

  let falling = enter({ ...context(0, [floor]), fallBoundary: pixels(2) });
  const supportLoss = [sample(falling, 0)];
  for (let tick = 1; tick <= 6; tick++) {
    falling = stepPlayerLife(falling, tick, "classic", {
      ...context(tick, []),
      fallBoundary: pixels(2),
    }).actor;
    supportLoss.push(sample(falling, tick));
  }
  check(
    supportLoss[1]?.body.vy === 55 &&
      supportLoss[3]?.presence === "present" &&
      supportLoss[4]?.presence === "removed" &&
      falling.lives === 3 &&
      falling.life === "respawning",
    "lost support floated or charged a life",
  );
  const result = {
    carry,
    fallback: sample(fallback, 0),
    waiting,
    retried: sample(retried.actor, 31),
    ready: sample(actor, 43),
    supportLoss,
  };
  return { ...result, hash: stateHash(result) };
}
