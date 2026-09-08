import type { AreaAnchor, CardinalHeading } from "../../src/game/combat/area-attack.js";
import {
  type BeamCast,
  type BeamPulse,
  castBeam,
  emitBeam,
  stepBeam,
} from "../../src/game/combat/beam.js";
import type { HurtTarget } from "../../src/game/combat/projectile.js";
import { LASER_ATTACK, LASER_PROFILE } from "../../src/game/content/weapons/laser.js";
import { stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import type { SweepTarget } from "../../src/game/physics/sweep.js";

const zero = { x: 0, y: 0 };
const source = {
  id: 1000,
  ownerId: 1,
  team: 1,
  actionInstanceId: 7,
  definitionId: LASER_ATTACK.id,
};
const body = (entityId: number, x: number, y = -4): HurtTarget => ({
  id: entityId * 10,
  entityId,
  team: 2,
  kind: "body",
  rect: { x: pixels(x), y: pixels(y), w: pixels(8), h: pixels(8) },
  delta: zero,
});
const wall = (x: number, y = -20): SweepTarget => ({
  id: 900,
  kind: "solid",
  rect: { x: pixels(x), y: pixels(y), w: pixels(1), h: pixels(40) },
  delta: zero,
});
interface BeamCase {
  name: string;
  heading?: CardinalHeading;
  maxTargets?: number;
  terrain?: SweepTarget[];
  targets?: HurtTarget[];
  hit: Array<number | null>;
  length?: number;
  stop?: BeamCast["stoppedBy"];
}
const cases: BeamCase[] = [
  { name: "empty-long-range", hit: [] },
  { name: "long-range-target", targets: [body(20, 400)], hit: [20] },
  { name: "range-endpoint", targets: [body(20, 512), body(21, 513)], hit: [20] },
  {
    name: "width-edges",
    targets: [body(20, 40, 2), body(21, 40, -10), body(22, 40, 1)],
    hit: [22],
  },
  {
    name: "thin-cover",
    terrain: [wall(300)],
    targets: [body(20, 400)],
    hit: [null],
    length: 300,
    stop: "terrain",
  },
  {
    name: "partial-cover",
    terrain: [wall(40, 1)],
    targets: [body(20, 80)],
    hit: [null],
    length: 40,
    stop: "terrain",
  },
  {
    name: "one-way-cover",
    terrain: [{ ...wall(40), kind: "one-way" }],
    targets: [body(20, 80)],
    hit: [null],
    length: 40,
    stop: "terrain",
  },
  {
    name: "muzzle-overlap",
    terrain: [wall(0)],
    targets: [body(20, 80)],
    hit: [null],
    length: 0,
    stop: "terrain",
  },
  {
    name: "cover-arriving",
    terrain: [{ ...wall(40, -60), delta: { x: 0, y: pixels(40) } }],
    targets: [body(20, 80)],
    hit: [null],
    length: 40,
    stop: "terrain",
  },
  {
    name: "cover-departing",
    terrain: [{ ...wall(40), delta: { x: 0, y: pixels(40) } }],
    targets: [body(20, 80)],
    hit: [20],
  },
  {
    name: "body-arriving",
    targets: [{ ...body(20, 40, -24), delta: { x: 0, y: pixels(24) } }],
    hit: [20],
  },
  {
    name: "body-crossing-between-samples",
    targets: [{ ...body(20, 40, -24), delta: { x: 0, y: pixels(48) } }],
    hit: [],
  },
  {
    name: "component-deduplication",
    maxTargets: 2,
    targets: [body(20, 20), { ...body(20, 22), id: 201 }, body(21, 30), body(22, 40)],
    hit: [20, 21],
    length: 30,
    stop: "penetration",
  },
  {
    name: "coincident-order",
    maxTargets: 2,
    targets: [body(22, 40), body(21, 40), body(20, 40)],
    hit: [20, 21],
    length: 40,
    stop: "penetration",
  },
  {
    name: "shield-before-body",
    targets: [body(20, 40), { ...body(20, 40), id: 201, kind: "shield" }, body(21, 60)],
    hit: [20],
    length: 40,
    stop: "shield",
  },
  {
    name: "terrain-before-shield",
    terrain: [wall(40)],
    targets: [body(20, 40), { ...body(20, 40), id: 201, kind: "shield" }],
    hit: [null],
    length: 40,
    stop: "terrain",
  },
  {
    name: "exposed-component-before-shield",
    targets: [body(20, 30), { ...body(20, 40), id: 201, kind: "shield" }, body(21, 60)],
    hit: [20],
    length: 40,
    stop: "shield",
  },
  {
    name: "allied-solid",
    targets: [{ ...body(20, 40), team: 1, solid: true }, body(21, 60)],
    hit: [20],
    length: 40,
    stop: "solid",
  },
  {
    name: "owner-and-allies",
    targets: [body(1, 10), { ...body(20, 20), team: 1 }, body(21, 60)],
    hit: [21],
  },
  { name: "up", heading: 1, targets: [body(20, -4, -48)], hit: [20] },
  { name: "down", heading: 2, targets: [body(20, -4, 40)], hit: [20] },
  { name: "left", heading: 3, targets: [body(20, -48)], hit: [20] },
];

interface ChargeCase {
  name: string;
  anchor(tick: number): AreaAnchor | null;
  frame(tick: number): { terrain: SweepTarget[]; targets: HurtTarget[] };
}
const charges: ChargeCase[] = [
  {
    name: "held-moving-muzzle",
    anchor: (tick) => ({ origin: { x: pixels(tick), y: 0 }, heading: 0 }),
    frame: () => ({ terrain: [], targets: [body(20, 100)] }),
  },
  {
    name: "held-turning-muzzle",
    anchor: (tick) => ({ origin: zero, heading: (tick % 4) as CardinalHeading }),
    frame: () => ({
      terrain: [],
      targets: [body(20, 100), body(21, -4, -108), body(22, -4, 100), body(23, -108)],
    }),
  },
  {
    name: "short-tap",
    anchor: (tick) => (tick === 1 ? { origin: zero, heading: 0 } : null),
    frame: () => ({ terrain: [], targets: [body(20, 100)] }),
  },
  {
    name: "interrupted-owner",
    anchor: (tick) => (tick < 4 ? { origin: zero, heading: 0 } : null),
    frame: () => ({ terrain: [], targets: [body(20, 100)] }),
  },
  {
    name: "moving-cover-and-target",
    anchor: () => ({ origin: zero, heading: 0 }),
    frame: (tick) => ({
      terrain: tick === 3 || tick === 4 ? [wall(40)] : [],
      targets: [body(20 + tick, 100)],
    }),
  },
];
interface ChargeFrame {
  tick: number;
  beam: BeamPulse | null;
  cast: BeamCast | null;
}
function runCharge(study: ChargeCase, restored?: BeamPulse) {
  let beam: BeamPulse;
  const frames: ChargeFrame[] = [],
    states: BeamPulse[] = [];
  if (restored) beam = restored;
  else {
    const anchor = study.anchor(1),
      frame = study.frame(1);
    if (!anchor) throw new Error("Missing charge birth");
    const result = emitBeam(
      source,
      1,
      LASER_ATTACK,
      LASER_PROFILE,
      anchor,
      frame.terrain,
      frame.targets,
    );
    beam = result.beam;
    frames.push({ tick: 1, ...result });
  }
  states.push(beam);
  while (beam.tick <= LASER_PROFILE.pulseTicks) {
    const tick = beam.tick + 1,
      frame = study.frame(tick),
      before = stateHash(beam);
    const result = stepBeam(
      beam,
      tick,
      LASER_ATTACK,
      LASER_PROFILE,
      study.anchor(tick),
      frame.terrain,
      frame.targets,
    );
    if (stateHash(beam) !== before) throw new Error(`Mutated prior charge: ${study.name}`);
    frames.push({ tick, ...result });
    if (!result.beam) return { frames, states, terminalTick: tick };
    beam = result.beam;
    states.push(beam);
  }
  throw new Error("Charge outlived its paid pulse interval");
}

/** Geometry and already-accepted charge continuation only; room input/ammo, wire delivery and SQLite are separate gates. */
export function beamProof() {
  return {
    scope:
      "Instantaneous energy-beam geometry and prepaid charge continuation in a deterministic fixture; no room input/ammo, event delivery, durable archive, media or production claim.",
    cases: cases.map((study) => {
      const definition = {
        ...LASER_ATTACK,
        maxTargets: study.maxTargets ?? LASER_ATTACK.maxTargets,
      };
      const query = (reverse: boolean) =>
        castBeam(
          source,
          definition,
          LASER_PROFILE,
          zero,
          study.heading ?? 0,
          reverse ? [...(study.terrain ?? [])].reverse() : (study.terrain ?? []),
          reverse ? [...(study.targets ?? [])].reverse() : (study.targets ?? []),
        );
      const cast = query(false),
        hash = stateHash(cast);
      if (stateHash(query(true)) !== hash) throw new Error(`Beam order dependence: ${study.name}`);
      if (
        stateHash(cast.impacts.map((impact) => impact.entityId)) !== stateHash(study.hit) ||
        cast.length !== pixels(study.length ?? 512) ||
        cast.stoppedBy !== (study.stop ?? null)
      )
        throw new Error(`Beam behavioral control failed: ${study.name}`);
      return { name: study.name, hash, cast };
    }),
    charges: charges.map((study) => {
      const result = runCharge(study),
        restoredTicks: number[] = [];
      for (const state of result.states) {
        const restored: BeamPulse = JSON.parse(JSON.stringify(state));
        if (
          stateHash(runCharge(study, restored).frames) !==
          stateHash(result.frames.filter((frame) => frame.tick > state.tick))
        )
          throw new Error(`Beam continuation changed: ${study.name}:${state.tick}`);
        restoredTicks.push(state.tick);
      }
      const followupDamage = result.frames
        .filter((frame) => frame.tick > 1)
        .flatMap((frame) => frame.cast?.impacts ?? [])
        .reduce((sum, impact) => sum + impact.damage, 0);
      if (followupDamage !== 0) throw new Error(`Repeated charge damage: ${study.name}`);
      return {
        name: study.name,
        hash: stateHash(result.frames),
        visibleTicks: result.states.length,
        terminalTick: result.terminalTick,
        restoredTicks,
        followupDamage,
        frames: result.frames,
      };
    }),
  };
}
