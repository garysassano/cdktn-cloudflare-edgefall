import type { HurtTarget } from "../../src/game/combat/projectile.js";
import {
  type Rocket,
  type RocketProfile,
  type RocketStep,
  createRocket,
  stepRocket,
} from "../../src/game/combat/rocket.js";
import {
  ROCKET_ATTACK,
  ROCKET_PROFILE,
  ROCKET_SHAPE,
} from "../../src/game/content/weapons/rocket-launcher.js";
import { stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import type { SweepTarget } from "../../src/game/physics/sweep.js";

interface RocketCase {
  name: string;
  heading: number;
  profile?: RocketProfile;
  frame(tick: number): { terrain: SweepTarget[]; hurtboxes: HurtTarget[] };
}
const source = {
  id: 1000,
  ownerId: 1,
  team: 1,
  actionInstanceId: 7,
  definitionId: ROCKET_ATTACK.id,
};
const body = (entityId: number, x: number, y = 0): HurtTarget => ({
  id: entityId * 10,
  entityId,
  team: 2,
  kind: "body",
  rect: { x: pixels(x - 4), y: pixels(y - 6), w: pixels(8), h: pixels(12) },
  delta: { x: 0, y: 0 },
});
const wall = (x: number): SweepTarget => ({
  id: 900,
  kind: "solid",
  rect: { x: pixels(x), y: -pixels(100), w: pixels(1), h: pixels(200) },
  delta: { x: 0, y: 0 },
});
const fast = {
  ...ROCKET_PROFILE,
  launchSpeed: pixels(32),
  maximumSpeed: pixels(32),
  blastRadius: pixels(16),
};
const cases: RocketCase[] = [
  {
    name: "crowded-impact",
    heading: 0,
    profile: fast,
    frame: () => ({
      terrain: [],
      hurtboxes: [body(500, 14), ...Array.from({ length: 16 }, (_, i) => body(20 + i, 8, 12))],
    }),
  },
  { name: "lifetime", heading: 0, frame: () => ({ terrain: [], hurtboxes: [] }) },
  ...([0, 8, 16, 24] as const).map((heading) => ({
    name: `guided-${heading}`,
    heading,
    frame: () => ({
      terrain: [],
      hurtboxes: [
        body(
          20,
          heading === 0 ? 200 : heading === 8 ? -40 : heading === 16 ? -200 : 40,
          heading === 0 ? 40 : heading === 8 ? 200 : heading === 16 ? -40 : -200,
        ),
      ],
    }),
  })),
  {
    name: "thin-wall",
    heading: 0,
    profile: fast,
    frame: () => ({ terrain: [wall(10)], hurtboxes: [body(20, 20)] }),
  },
  {
    name: "moving-wall",
    heading: 0,
    profile: fast,
    frame: () => ({
      terrain: [{ ...wall(19), delta: { x: -pixels(32), y: 0 } }],
      hurtboxes: [body(20, 14), body(21, 25)],
    }),
  },
  {
    name: "moving-victims",
    heading: 0,
    profile: fast,
    frame: () => ({
      terrain: [],
      hurtboxes: [
        body(20, 14),
        { ...body(21, 10, 40), delta: { x: 0, y: -pixels(40) } },
        { ...body(22, 10, 10), delta: { x: 0, y: pixels(40) } },
      ],
    }),
  },
  {
    name: "crossing",
    heading: 0,
    profile: fast,
    frame: () => ({
      terrain: [],
      hurtboxes: [{ ...body(20, 16, -20), delta: { x: 0, y: pixels(40) } }],
    }),
  },
  {
    name: "shield",
    heading: 0,
    profile: fast,
    frame: () => ({
      terrain: [],
      hurtboxes: [body(20, 20), { ...body(20, 16), id: 201, kind: "shield" }],
    }),
  },
  {
    name: "overlapping-hurtboxes",
    heading: 0,
    profile: fast,
    frame: () => ({
      terrain: [],
      hurtboxes: [body(20, 14), { ...body(20, 14), id: 201 }, body(21, 20)],
    }),
  },
  {
    name: "covered-lock",
    heading: 0,
    frame: (tick) => ({
      terrain: tick < 3 ? [] : [wall(100)],
      hurtboxes: tick < 3 ? [body(20, 200)] : [body(20, 200), body(21, 60)],
    }),
  },
  {
    name: "dead-lock",
    heading: 0,
    frame: (tick) => ({ terrain: [], hurtboxes: tick < 3 ? [body(20, 200)] : [body(21, 60)] }),
  },
];

function run(study: RocketCase, restored?: Rocket, reverse = false) {
  const profile = study.profile ?? ROCKET_PROFILE,
    definition = {
      ...ROCKET_ATTACK,
      speed: profile.launchSpeed,
      lifetimeTicks: profile.lifetimeTicks,
    };
  let rocket = restored ?? createRocket(source, { x: 0, y: 0 }, study.heading, 1, profile);
  const steps: RocketStep[] = [],
    states: Rocket[] = [rocket];
  while (rocket.tick - rocket.spawnTick < profile.lifetimeTicks) {
    const { terrain, hurtboxes } = study.frame(rocket.tick + 1);
    if (reverse) {
      terrain.reverse();
      hurtboxes.reverse();
    }
    const step = stepRocket(
      rocket,
      rocket.tick + 1,
      definition,
      ROCKET_SHAPE,
      profile,
      terrain,
      hurtboxes,
    );
    steps.push(step);
    if (step.status !== "active") return { steps, states, terminal: step };
    rocket = step.rocket;
    states.push(rocket);
  }
  throw new Error("Rocket exceeded its lifetime");
}

/** Portable released-projectile proof; room input, ammunition and storage wiring are separate. */
export function rocketProof() {
  return {
    scope:
      "Released rocket acceleration, guidance, collision and blast timing in a deterministic fixture; no launcher UI, room wiring, media or production claim.",
    cases: cases.map((study) => {
      const result = run(study),
        traceHash = stateHash(result.steps);
      if (stateHash(run(study, undefined, true).steps) !== traceHash)
        throw new Error(`Rocket order dependence: ${study.name}`);
      const restoredTicks: number[] = [];
      for (const tick of [1, 2, 3, 4, 7, 8, 20, 50, 89]) {
        const state = result.states.find((state) => state.tick === tick);
        if (!state) continue;
        const restored: Rocket = JSON.parse(JSON.stringify(state));
        const replay = run(study, restored);
        if (stateHash(replay.steps) !== stateHash(result.steps.slice(tick - 1)))
          throw new Error(`Rocket continuation changed at ${study.name}:${tick}`);
        restoredTicks.push(tick);
      }
      const locks = result.states
        .filter((state, i, states) => i === 0 || state.targetId !== states[i - 1]?.targetId)
        .map(({ tick, targetId }) => ({ tick, targetId }));
      return {
        name: study.name,
        ticks: result.steps.length,
        traceHash,
        restoredTicks,
        headings: [...new Set(result.states.map((state) => state.heading))],
        maximumSpeed: Math.max(...result.states.map((state) => state.speed)),
        locks,
        terminal: result.terminal,
      };
    }),
  };
}
