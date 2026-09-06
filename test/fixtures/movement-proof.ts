import { stateHash } from "../../src/game/core/canonical.js";
import { pixels, randomStep } from "../../src/game/core/numeric.js";
import { type KinematicState, moveKinematic } from "../../src/game/physics/move.js";
import type { SweepTarget } from "../../src/game/physics/sweep.js";

export function movingCase(seed: number): { input: KinematicState; targets: SweepTarget[] } {
  let rng = seed;
  const next = (range: number) => {
    rng = randomStep(rng);
    return rng % range;
  };
  const input: KinematicState = {
    rect: { x: 0, y: 0, w: 10, h: 10 },
    motion: { x: next(81) - 40, y: next(81) - 40 },
    supportId: null,
  };
  const targets: SweepTarget[] = Array.from({ length: 4 }, (_, index) => ({
    id: index + 1,
    rect: { x: next(101) - 50, y: next(101) - 50, w: next(20) + 1, h: next(20) + 1 },
    kind: "solid",
    delta: { x: next(81) - 40, y: next(81) - 40 },
  }));
  return { input, targets };
}

export function movingCasesProof() {
  const outcomes = Array.from({ length: 512 }, (_, index) => {
    const seed = index + 1;
    const { input, targets } = movingCase(seed);
    const result = moveKinematic(input, targets);
    if (result.status !== "complete" && result.status !== "crushed")
      throw new Error(`Moving case ${seed}: ${result.status}`);
    return { seed, result };
  });
  return {
    outcomes,
    complete: outcomes.filter(({ result }) => result.status === "complete").length,
    crushed: outcomes.filter(({ result }) => result.status === "crushed").length,
    traceHash: stateHash(outcomes),
  };
}

/** Engineering gravity/carry/drop fixture, not the final controller or gameplay replay. */
export function movementProof(restoreAfterTick?: number) {
  let body: KinematicState = {
    rect: { x: pixels(40), y: pixels(66), w: pixels(14), h: pixels(34) },
    motion: { x: 0, y: 0 },
    supportId: 1,
  };
  const platform: SweepTarget = {
    id: 1,
    rect: { x: 0, y: pixels(100), w: pixels(160), h: pixels(8) },
    delta: { x: 0, y: 0 },
    kind: "one-way",
  };
  const floor: SweepTarget = {
    id: 2,
    rect: { x: pixels(-200), y: pixels(220), w: pixels(600), h: pixels(20) },
    delta: { x: 0, y: 0 },
    kind: "solid",
  };
  const trace: Array<{ tick: number; bodyHash: string; geometryHash: string }> = [];
  const checkpoints: Array<{
    tick: number;
    x: number;
    y: number;
    supportId: number | null;
    geometryRevision: number;
  }> = [];
  let contacts = 0;
  for (let tick = 1; tick <= 1200; tick++) {
    const direction = Math.floor((tick - 1) / 60) % 2 === 0 ? 1 : -1;
    platform.delta = { x: pixels(direction), y: pixels(-direction) };
    body.motion = {
      x: 0,
      y: tick === 240 ? pixels(-12) : Math.min(pixels(8), body.motion.y + pixels(1)),
    };
    const geometryRevision = tick < 900 ? 1 : 2;
    const terrain = geometryRevision === 1 ? [platform, floor] : [floor];
    const result = moveKinematic(
      body,
      terrain,
      tick >= 600 && tick <= 620 ? { ignoredOneWayId: 1 } : {},
    );
    if (result.status !== "complete")
      throw new Error(`Movement proof tick ${tick}: ${result.status}`);
    body = result;
    contacts += result.contacts.length;
    platform.rect = {
      ...platform.rect,
      x: platform.rect.x + platform.delta.x,
      y: platform.rect.y + platform.delta.y,
    };
    trace.push({
      tick,
      bodyHash: stateHash(body),
      geometryHash: stateHash({ geometryRevision, terrain }),
    });
    if (tick % 60 === 0 || [239, 241, 599, 601, 899, 901].includes(tick))
      checkpoints.push({
        tick,
        x: body.rect.x,
        y: body.rect.y,
        supportId: body.supportId,
        geometryRevision,
      });
    if (tick === restoreAfterTick) {
      // Deliberately restore only authoritative kinematics, not prior diagnostic contacts.
      body = JSON.parse(
        JSON.stringify({ rect: body.rect, motion: body.motion, supportId: body.supportId }),
      ) as KinematicState;
      platform.rect = JSON.parse(JSON.stringify(platform.rect)) as typeof platform.rect;
    }
  }
  return { ticks: 1200, traceHash: stateHash(trace), contacts, checkpoints };
}
