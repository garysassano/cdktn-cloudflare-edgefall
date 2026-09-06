import { stateHash } from "../../src/game/core/canonical.js";
import { createControllerLab, stepControllerLab } from "../../src/game/labs/controller.js";
import { moveKinematic } from "../../src/game/physics/move.js";
import type { Point, Rect } from "../../src/game/state.js";

export function seamProof() {
  const results = [];
  const rotateRect = (rect: Rect): Rect => ({
    x: -rect.y - rect.h,
    y: rect.x,
    w: rect.h,
    h: rect.w,
  });
  const rotatePoint = (point: Point): Point => ({ x: -point.y, y: point.x });
  let body = { x: 0, y: 0, w: 10, h: 10 };
  let a = { x: -20, y: 10, w: 30, h: 10 };
  let b = { x: 10, y: 10, w: 30, h: 10 };
  let motion = { x: 5, y: 2 };
  let expected = { x: 5, y: 0, w: 10, h: 10 };
  for (let rotation = 0; rotation < 4; rotation++) {
    const targets = [a, b].map((rect, i) => ({
      id: i + 1,
      rect,
      delta: { x: 0, y: 0 },
      kind: "solid" as const,
    }));
    const forward = moveKinematic({ rect: body, motion, supportId: null }, targets);
    const reverse = moveKinematic({ rect: body, motion, supportId: null }, [...targets].reverse());
    results.push({ rotation, expected, forward, reverse });
    body = rotateRect(body);
    a = rotateRect(a);
    b = rotateRect(b);
    motion = rotatePoint(motion);
    expected = rotateRect(expected);
  }
  return { results, traceHash: stateHash(results) };
}
export function groundedProof(restoreAt?: number) {
  let state = createControllerLab("enemy-ledge");
  let traceHash = "00000000";
  const checkpoints = [];
  for (let tick = 1; tick <= 1200; tick++) {
    state = stepControllerLab(state, {
      held: 0,
      jumpPressed: tick % 60 === 1,
      removePlatform: tick === 901,
    });
    if (state.stopped) throw new Error(`Enemy lab stopped: ${state.stopped}`);
    traceHash = stateHash({
      traceHash,
      tick,
      actor: state.actor,
      enemy: state.enemy,
      resolvedEnemies: state.resolvedEnemies,
    });
    if ([1, 300, 600, 900, 901, 960, 1200].includes(tick))
      checkpoints.push({ tick, enemy: state.enemy, geometryRevision: state.geometryRevision });
    // Plain state restoration only; enemy network snapshot sections are still W04 work.
    if (tick === restoreAt) state = JSON.parse(JSON.stringify(state));
  }
  return { ticks: 1200, traceHash, checkpoints };
}
