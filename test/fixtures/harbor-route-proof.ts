import { stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import { EncounterLifecycle } from "../../src/game/encounters/lifecycle.js";
import { Held } from "../../src/game/input/types.js";
import {
  type CombatCommand,
  type CombatLab,
  advanceCombatLab,
  combatEncounterDefinition,
  createCombatLab,
} from "../../src/game/labs/combat.js";
import { COMBAT_SHAPES, TANK_PROFILE } from "../../src/game/labs/combat-content.js";
import content from "../../src/game/missions/compiled/harbor.json" with { type: "json" };
import {
  HARBOR,
  HARBOR_TERRAIN,
  harborDepot,
  harborStage,
} from "../../src/game/missions/harbor-content.js";
import { worldRect } from "../../src/game/physics/body.js";
import type { Rect } from "../../src/game/state.js";
import { tankOwner } from "../../src/game/vehicles/tank.js";

export const HARBOR_ROUTE_MODES = ["foot", "tank", "spent-tanks"] as const;
export type HarborRouteMode = (typeof HARBOR_ROUTE_MODES)[number];
const idle: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  interactPressed: false,
  specialPressed: false,
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Harbor route: ${message}`);
}
function required<T>(value: T | undefined): T {
  check(value !== undefined, "missing fixture value");
  return value;
}
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** The exact Harbor geometry without encounter rosters, used to isolate mandatory route clearance. */
export function harborRouteInitial(players: number) {
  const world = createCombatLab("range", players);
  for (const player of world.players) {
    const entry = HARBOR.checkpoints[0];
    player.body.x = pixels(entry.x + player.slot * 24);
    player.body.y = pixels(entry.y);
    player.body.supportId = entry.supportId;
  }
  world.targets = [];
  world.props = [];
  world.tanks = harborDepot(players);
  world.nextEntityId = 2000;
  world.encounter = new EncounterLifecycle(combatEncounterDefinition(world)).begin();
  return world;
}

function assertBodies(world: CombatLab) {
  for (const player of world.players) {
    check(player.life === "alive" && player.lives === 3, "route consumed a player life");
    check(player.body.y <= pixels(HARBOR.fallBoundary), "player crossed the kill boundary");
    if (player.vehicleId !== null) continue;
    const shape = required(COMBAT_SHAPES.get(player.body.shapeId));
    const rect = worldRect(player.body, shape.rect, player.facing);
    check(
      !HARBOR_TERRAIN.some((surface) => surface.kind === "solid" && overlaps(rect, surface.rect)),
      "player overlaps route geometry",
    );
  }
  for (const tank of world.tanks) {
    const owner = world.players.find((player) => player.playerId === tankOwner(tank));
    check(
      owner
        ? owner.vehicleId === tank.body.id
        : world.players.every((player) => player.vehicleId !== tank.body.id),
      "seat ownership diverged",
    );
    if (owner) {
      check(owner.body.x === tank.body.x, "driver detached horizontally");
      check(
        owner.body.y === tank.body.y + TANK_PROFILE.definition.seat.socket.y,
        "driver detached vertically",
      );
    }
    if (tank.lifecycle === "wreck") continue;
    const rect = worldRect(
      tank.body,
      required(COMBAT_SHAPES.get(tank.body.shapeId)).rect,
      tank.facing,
    );
    check(
      !HARBOR_TERRAIN.some((surface) => surface.kind === "solid" && overlaps(rect, surface.rect)),
      "tank overlaps route geometry",
    );
  }
}

/** The director reads accepted state and emits ordinary intent, including jumps after wall contact. */
export function recordHarborRoute(mode: HarborRouteMode, players: number) {
  let world = harborRouteInitial(players);
  const stage = harborStage(0);
  const phases = Array.from(
    { length: players },
    () => "approach" as "approach" | "boarded" | "released" | "return",
  );
  const commands: CombatCommand[][] = [];
  const hashes = [stateHash(world)];
  let commandHash = stateHash([]);
  const checkpoints: Array<{ tick: number; world: CombatLab }> = [];
  const observations: Array<{
    tick: number;
    hash: string;
    positions: Array<{ x: number; y: number; vehicleId: number | null }>;
    tankLifecycles: string[];
  }> = [];
  const entered = new Set<number>(),
    fired = new Set<number>(),
    visited = new Set<string>();
  const save = () => {
    checkpoints.push({ tick: world.tick, world: structuredClone(world) });
    observations.push({
      tick: world.tick,
      hash: stateHash(world),
      positions: world.players.map((player) => ({
        x: player.body.x,
        y: player.body.y,
        vehicleId: player.vehicleId,
      })),
      tankLifecycles: world.tanks.map((tank) => tank.lifecycle),
    });
  };
  save();
  let finished = false,
    recordedBoarding = false;
  while (world.tick < 10_000) {
    const row = world.players.map((player) => {
      const slot = player.slot;
      const tank = required(world.tanks[slot]);
      const command = { ...idle };
      const x = player.body.x / 256;
      for (const beat of HARBOR.beats)
        if (x >= beat.start && x < beat.end) visited.add(`${slot}:${beat.id}`);
      const go = (destination: number) => {
        if (x < destination - 2) command.held |= Held.Right;
        else if (x > destination + 2) command.held |= Held.Left;
      };
      if (mode === "foot") {
        if (x >= HARBOR.width - 88) phases[slot] = "return";
        go(phases[slot] === "return" ? HARBOR.checkpoints[0].x + slot * 24 : HARBOR.width - 80);
      } else if (phases[slot] === "approach") {
        go(HARBOR.depot.firstX + slot * HARBOR.depot.spacing - 24);
        if (Math.abs(x - (HARBOR.depot.firstX + slot * HARBOR.depot.spacing - 24)) <= 3)
          command.interactPressed = world.tick % 16 === slot;
        if (tank.lifecycle === "occupied" && tank.occupantId === player.playerId) {
          phases[slot] = "boarded";
          entered.add(player.playerId);
        }
      } else if (mode === "spent-tanks" && phases[slot] === "boarded") {
        command.held = Held.VehicleSpecial;
        command.specialPressed = tank.special.phase === "ready";
        if (player.vehicleId === null) phases[slot] = "released";
      } else {
        go(HARBOR.width - 80);
        if (mode === "tank" && player.vehicleId !== null && world.tick % 120 < 20)
          command.held |= Held.Fire;
      }
      const body = player.vehicleId === null ? player.body : tank.body;
      const direction = command.held & Held.Right ? 1 : command.held & Held.Left ? -1 : 0;
      command.jumpPressed =
        body.grounded &&
        body.contacts.some((contact) => contact.normalX === -direction && direction !== 0);
      return command;
    });
    const before = stateHash(world);
    const next = advanceCombatLab(world, row, undefined, stage).state;
    check(stateHash(world) === before, "advance mutated its accepted input");
    world = next;
    commands.push(row);
    commandHash = stateHash([commandHash, row]);
    hashes.push(stateHash(world));
    assertBodies(world);
    for (const event of world.events)
      if (event.kind === "shot" && event.source && "vehicleId" in event.source)
        fired.add(event.ownerId);
    if ([1800, 3599, 3600, 3601, 4200, 6000].includes(world.tick)) save();
    if (entered.size === players && !recordedBoarding) {
      save();
      recordedBoarding = true;
    }
    finished = world.players.every((player) =>
      mode === "foot"
        ? phases[player.slot] === "return" &&
          Math.abs(player.body.x / 256 - (HARBOR.checkpoints[0].x + player.slot * 24)) <= 3
        : player.body.x >= pixels(HARBOR.width - 88),
    );
    if (finished) break;
  }
  check(
    finished,
    `route did not finish: ${mode}/${players}, positions ${world.players.map((player) => `${player.body.x / 256},${player.body.y / 256},${phases[player.slot]}`).join(";")}`,
  );
  check(world.tick > 3600, "full traversal did not exercise the extended mission clock");
  check(visited.size === HARBOR.beats.length * players, "a player skipped a route beat");
  if (mode !== "foot") check(entered.size === players, "not every player boarded a separate tank");
  if (mode === "tank") check(fired.size === players, "not every driver fired on the bridge");
  if (mode === "spent-tanks")
    check(
      world.tanks.every((tank) => tank.lifecycle === "wreck"),
      "spent depot tank remained usable",
    );
  const continuations = checkpoints
    .filter((checkpoint) => checkpoint.tick + 8 <= world.tick)
    .map((checkpoint) => {
      let restored = JSON.parse(JSON.stringify(checkpoint.world)) as CombatLab;
      for (let tick = checkpoint.tick; tick < checkpoint.tick + 8; tick++)
        restored = advanceCombatLab(restored, required(commands[tick]), undefined, stage).state;
      check(
        stateHash(restored) === hashes[checkpoint.tick + 8],
        "serialized route continuation diverged",
      );
      return { tick: checkpoint.tick, throughTick: checkpoint.tick + 8, hash: stateHash(restored) };
    });
  save();
  return {
    mode,
    players,
    contentHash: content.contentHash,
    ticks: world.tick,
    finalHash: stateHash(world),
    commandHash,
    entered: [...entered].sort(),
    fired: [...fired].sort(),
    visited: [...visited].sort(),
    lives: world.players.map((player) => player.lives),
    armor: world.tanks.map((tank) => tank.armor),
    observations,
    continuations,
  };
}

export function harborRouteProof() {
  return HARBOR_ROUTE_MODES.flatMap((mode) =>
    [1, 2, 4].map((players) => recordHarborRoute(mode, players)),
  );
}
