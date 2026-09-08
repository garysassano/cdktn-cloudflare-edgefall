import { stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import { Held } from "../../src/game/input/types.js";
import {
  type CombatCommand,
  type CombatLab,
  type CombatStage,
  advanceCombatLab,
  createCombatLab,
} from "../../src/game/labs/combat.js";
import { COMBAT_SHAPES, TANK_PROFILE } from "../../src/game/labs/combat-content.js";
import { footTerrain } from "../../src/game/labs/foot-fixture.js";
import { worldRect } from "../../src/game/physics/body.js";
import type { Rect } from "../../src/game/state.js";
import { tankOwner } from "../../src/game/vehicles/tank.js";

export const TANK_TERRAIN_CASES = [
  "lower-depot",
  "lower-special",
  "lower-damage",
  "ledge-landing",
  "ledge-fall",
  "step",
  "ceiling",
  "narrow-pass",
  "narrow-block",
  "lift",
  "crush",
  "blocked-exit",
  "blocked-disconnect",
  "crossing",
] as const;
export type TankTerrainCase = (typeof TANK_TERRAIN_CASES)[number];
const idle: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  interactPressed: false,
  specialPressed: false,
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Tank terrain: ${message}`);
}
function required<T>(value: T | undefined): T {
  check(value !== undefined, "missing fixture value");
  return value;
}
const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const lane = (name: TankTerrainCase, slot: number) => slot * (name === "crossing" ? 56 : 1024);
const floorY = (name: TankTerrainCase) => (name.startsWith("lower-") ? 360 : 200);
const duration = (name: TankTerrainCase) =>
  ["crush", "blocked-disconnect"].includes(name) ? 180 : 130;
const age = (tick: number, start: number, length: number) =>
  Math.max(0, Math.min(length, tick - start));

/** Authored geometry at the start of the tick plus exact motion to its end. */
export function tankTerrainStage(
  name: TankTerrainCase,
  tick: number,
  players: number,
): CombatStage {
  const floor = floorY(name),
    height = -required(COMBAT_SHAPES.get(TANK_PROFILE.locomotion.standingShapeId)).rect.y / 256;
  const terrain = Array.from({ length: name === "crossing" ? 1 : players }, (_, slot) => {
    const x = lane(name, slot),
      id = 100 + slot;
    if (name === "crossing") return [footTerrain(id, -256, floor, 1536, 16)];
    if (name === "ledge-landing" || name === "ledge-fall")
      return [
        footTerrain(id, x, floor, 120, 16),
        ...(name === "ledge-landing"
          ? [footTerrain(200 + slot, x + 120, floor + 32, 392, 16)]
          : []),
      ];
    if (name === "lift" || name === "crush") {
      const displacement = (t: number) =>
        age(t, 30, name === "lift" ? 70 : 20) * (name === "lift" ? 2 : -2);
      return [
        {
          ...footTerrain(id, x, floor + displacement(tick - 1), 384, 16),
          delta: { x: 0, y: pixels(displacement(tick) - displacement(tick - 1)) },
        },
        ...(name === "crush" ? [footTerrain(200 + slot, x, 120, 384, 24)] : []),
      ];
    }
    if (name === "blocked-exit" || name === "blocked-disconnect") {
      const closed = (t: number) => age(t, 12, 16) - age(t, 50, 16);
      const previous = closed(tick - 1) * 2,
        delta = pixels((closed(tick) - closed(tick - 1)) * 2);
      return [
        footTerrain(id, x, floor, 512, 16),
        { ...footTerrain(200 + slot * 3, x + previous, 140, 4, 60), delta: { x: delta, y: 0 } },
        {
          ...footTerrain(201 + slot * 3, x + 116 - previous, 140, 4, 60),
          delta: { x: -delta, y: 0 },
        },
        {
          ...footTerrain(202 + slot * 3, x + 32, 108 + previous, 56, 4),
          delta: { x: 0, y: delta },
        },
      ];
    }
    return [
      footTerrain(id, x, floor, 512, 16),
      ...(name === "step" ? [footTerrain(200 + slot, x + 128, 168, 64, 32)] : []),
      ...(name === "ceiling" ? [footTerrain(200 + slot, x + 114, 138, 140, 18)] : []),
      ...(name.startsWith("narrow-")
        ? [
            footTerrain(
              200 + slot,
              x + 128,
              120,
              128,
              floor - height - 120 + Number(name === "narrow-block"),
            ),
          ]
        : []),
    ];
  }).flat();
  if (["crush", "blocked-disconnect"].includes(name))
    terrain.push(footTerrain(900, 550, 200, 384, 16));
  return {
    terrain,
    destructibles: [],
    enemyBounds: { x: pixels(-256), y: 0, w: pixels(players * 1024 + 256), h: pixels(512) },
    fallBoundary: pixels(name === "ledge-fall" ? 232 : name === "lift" ? 388 : floor + 48),
    entry: {
      x: pixels(["crush", "blocked-disconnect"].includes(name) ? 600 : 36),
      y: pixels(floor),
    },
    activeEnemyIds: new Set<number>(),
    extraHurtboxes: [],
  };
}
export function tankTerrainInitial(name: TankTerrainCase, players: number) {
  const world = createCombatLab("tank", players),
    floor = floorY(name);
  for (const actor of world.players) {
    actor.body.x = pixels(36 + lane(name, actor.slot));
    actor.body.y = pixels(floor);
    actor.body.supportId = name === "crossing" ? 100 : 100 + actor.slot;
    const tank = required(world.tanks[actor.slot]);
    tank.body.x = pixels(60 + lane(name, actor.slot));
    tank.body.y = pixels(floor);
    tank.body.supportId = actor.body.supportId;
  }
  return world;
}
export function tankTerrainCommands(
  name: TankTerrainCase,
  tick: number,
  players: number,
): CombatCommand[] {
  return Array.from({ length: players }, (_, slot) => {
    const driving = [
      "ledge-landing",
      "ledge-fall",
      "step",
      "ceiling",
      "narrow-pass",
      "narrow-block",
      "crossing",
    ].includes(name);
    let held = driving && tick >= 13 && tick <= 90 ? Held.Right : 0;
    if (name === "lower-depot" && tick >= 13 && tick <= 25) held = Held.Right;
    if (name === "crossing" && tick >= 13 && tick <= 70)
      held = (slot < players / 2 ? Held.Right : Held.Left) | Held.Fire;
    if (name === "crossing" && tick > 70) held = 0;
    if (name === "narrow-block" && tick >= 50) held = tick < 66 ? Held.Left : 0;
    if (name === "lower-special" && tick >= 13 && tick <= 42) held = Held.VehicleSpecial;
    return {
      ...idle,
      held,
      jumpPressed: (name === "step" && tick === 35) || (name === "ceiling" && tick === 25),
      interactPressed:
        tick === 1 ||
        (name === "lower-depot" && tick === 32) ||
        (name === "ledge-landing" && tick === 100) ||
        (name === "lift" && tick === 110) ||
        (name === "blocked-exit" && [30, 80].includes(tick)) ||
        (name === "narrow-block" && tick === 70),
      specialPressed: name === "lower-special" && tick === 13,
      grenadePressed: name === "crossing" && tick === 17,
      firePressed: name === "crossing" && tick === 13,
    };
  });
}
function advance(name: TankTerrainCase, current: CombatLab) {
  const tick = current.tick + 1,
    players = current.players.length;
  const before = structuredClone(current);
  // Authored hostile projectiles enter from outside each hull; only normal impact code debits armor.
  if (name === "lower-damage" && [30, 61, 92].includes(tick))
    for (const tank of before.tanks)
      before.projectiles.push({
        id: before.nextEntityId++,
        ownerId: 20,
        team: 2,
        actionInstanceId: before.nextActionId++,
        definitionId: 3,
        position: { x: tank.body.x + pixels(21), y: tank.body.y - pixels(12) },
        velocity: { x: -pixels(8), y: 0 },
        spawnTick: before.tick,
      });
  const connections = {
    connectedPlayerIds: before.players.map((player) => player.playerId),
    releasePlayerIds:
      name === "blocked-disconnect" && tick === 30
        ? before.players.map((player) => player.playerId)
        : [],
  };
  const stage = tankTerrainStage(name, tick, players),
    saved = stateHash(before);
  const result = advanceCombatLab(
    before,
    tankTerrainCommands(name, tick, players),
    connections,
    stage,
  );
  check(stateHash(before) === saved, `${name} mutated accepted state at ${tick}`);
  const world = result.state;
  for (const tank of world.tanks) {
    if (tank.lifecycle !== "wreck") {
      const rect = worldRect(
        tank.body,
        required(COMBAT_SHAPES.get(tank.body.shapeId)).rect,
        tank.facing,
      );
      check(
        !stage.terrain.some(
          (target) =>
            target.kind === "solid" &&
            overlap(rect, {
              ...target.rect,
              x: target.rect.x + target.delta.x,
              y: target.rect.y + target.delta.y,
            }),
        ),
        `${name} accepted overlapping hull at ${tick}`,
      );
    }
    const owner = world.players.find((player) => player.playerId === tankOwner(tank));
    check(
      owner
        ? owner.vehicleId === tank.body.id &&
            owner.body.x === tank.body.x &&
            owner.body.y === tank.body.y - pixels(6)
        : world.players.every((player) => player.vehicleId !== tank.body.id),
      `${name} lost bilateral seat at ${tick}`,
    );
  }
  return result;
}
export function recordTankTerrain(name: TankTerrainCase, players: number) {
  let world = tankTerrainInitial(name, players);
  const states = [structuredClone(world)],
    observations = [];
  for (let tick = 1; tick <= duration(name); tick++) {
    const result = advance(name, world);
    world = result.state;
    states.push(structuredClone(world));
    observations.push({
      tick,
      hash: stateHash(world),
      tanks: world.tanks.map((tank) => ({
        id: tank.body.id,
        lifecycle: tank.lifecycle,
        owner: tankOwner(tank),
        controlEpoch: tank.controlEpoch,
        armor: tank.armor,
        body: tank.body,
        special: tank.special.phase,
        shells: tank.secondary.ammo,
      })),
      players: world.players.map((player) => ({
        id: player.playerId,
        vehicleId: player.vehicleId,
        life: player.life,
        lives: player.lives,
        body: player.body,
      })),
      outcomes: result.outcomes,
      events: world.events.map((event) => ({
        kind: event.kind,
        targetId: event.targetId,
        definitionId: event.source?.definitionId ?? null,
      })),
    });
  }
  return { name, players, states, observations, final: world };
}
export function assertTankTerrain(record: ReturnType<typeof recordTankTerrain>) {
  const { name, players, states, final, observations } = record;
  const at = (tick: number) => required(states[tick]);
  check(
    at(12).tanks.every((tank) => tank.lifecycle === "occupied"),
    `${name} did not board every driver`,
  );
  if (["ledge-fall", "crush", "blocked-disconnect"].includes(name)) {
    check(
      final.players.every((player) => player.lives === 2 && player.vehicleId === null),
      `${name} did not consume exactly one life`,
    );
    check(
      final.tanks.every(
        (tank) => tank.lifecycle === (name === "blocked-disconnect" ? "available" : "wreck"),
      ),
      `${name} did not settle every hull`,
    );
  } else
    check(
      final.players.every((player) => player.lives === 3),
      `${name} consumed a life`,
    );
  if (name === "lower-depot")
    check(
      final.players.every((player) => player.vehicleId === null && player.body.y === pixels(360)),
      "lower depot ejection failed",
    );
  if (name === "lower-special") {
    check(
      at(42).tanks.every((tank) => tank.special.phase === "charging"),
      "lower sacrifice did not commit",
    );
    check(
      observations
        .flatMap((step) => step.events)
        .filter((event) => event.kind === "explosion" && event.definitionId === 20).length ===
        players,
      "lower sacrifice did not blast once per hull",
    );
  }
  if (name === "lower-damage") {
    check(
      final.tanks.every((tank) => tank.lifecycle === "wreck"),
      "lower incoming damage did not destroy hulls",
    );
    check(
      final.players.every((player) => player.vehicleId === null && player.body.y === pixels(360)),
      "lower destruction did not eject safely",
    );
  }
  if (name === "ledge-landing")
    check(
      final.tanks.every((tank) => tank.body.grounded && tank.body.y === pixels(232)),
      "ledge landing lost support",
    );
  if (name === "step") {
    check(
      at(34).tanks.every((tank, slot) => tank.body.x === pixels(lane(name, slot) + 108)),
      "step did not stop unjumped hulls",
    );
    check(
      observations.some((step) =>
        step.tanks.every((tank) => tank.body.supportId !== null && tank.body.supportId >= 200),
      ),
      "tank never landed on step",
    );
    check(
      final.tanks.every(
        (tank, slot) => tank.body.x > pixels(lane(name, slot) + 212) && tank.body.y === pixels(200),
      ),
      "step route failed",
    );
  }
  if (name === "ceiling")
    check(
      observations.some((step) =>
        step.tanks.every((tank) => tank.body.contacts.some((contact) => contact.normalY === 1)),
      ),
      "jump did not touch ceiling",
    );
  if (name === "narrow-pass")
    check(
      final.tanks.every((tank, slot) => tank.body.x > pixels(lane(name, slot) + 276)),
      "exact-height passage blocked hulls",
    );
  if (name === "narrow-block") {
    check(
      at(49).tanks.every((tank, slot) => tank.body.x === pixels(lane(name, slot) + 108)),
      "undersized passage failed to block hulls",
    );
    check(
      final.players.every((player) => player.vehicleId === null),
      "blocked route prevented retreat and exit",
    );
  }
  if (name === "lift")
    check(
      final.players.every((player) => player.vehicleId === null && player.body.y === pixels(340)),
      "moving support exit failed",
    );
  if (["crush", "blocked-disconnect"].includes(name))
    check(
      final.players.every((player) => player.life === "alive" && player.body.x >= pixels(600)),
      "forced exit failed to return players at safe checkpoint",
    );
  if (name === "blocked-exit") {
    check(
      at(30).tanks.every((tank) => tank.lifecycle === "occupied"),
      "blocked voluntary exit lost control",
    );
    check(
      required(observations[29]).outcomes.every((outcome) => outcome.interact === "unavailable"),
      "blocked exit incorrectly acknowledged",
    );
    check(
      final.players.every((player) => player.vehicleId === null),
      "opened exit remained blocked",
    );
  }
  if (name === "crossing") {
    check(
      final.tanks.every((tank) => tank.armor === 3 && tank.secondary.ammo === 9),
      "friendly crossing caused damage or lost ordnance",
    );
    if (players === 4)
      check(
        required(final.tanks[0]).body.x > required(final.tanks[3]).body.x &&
          required(final.tanks[1]).body.x > required(final.tanks[2]).body.x,
        "friendly tanks blocked crossing",
      );
  }
}
export function tankTerrainProof() {
  return [1, 4].flatMap((players) =>
    TANK_TERRAIN_CASES.map((name) => {
      const record = recordTankTerrain(name, players);
      assertTankTerrain(record);
      const checkpoints = [12, 29, 42, 70, 100].map((tick) => {
        let restored: CombatLab = JSON.parse(JSON.stringify(required(record.states[tick])));
        for (let step = 0; step < 8; step++) restored = advance(name, restored).state;
        const hash = stateHash(restored);
        check(
          hash === stateHash(required(record.states[tick + 8])),
          `${name} diverged after restore at ${tick}`,
        );
        return { tick, resumedTick: restored.tick, hash };
      });
      return {
        name,
        players,
        ticks: record.final.tick,
        finalHash: stateHash(record.final),
        traceHash: stateHash(record.observations),
        checkpoints,
        observations: record.observations,
      };
    }),
  );
}
