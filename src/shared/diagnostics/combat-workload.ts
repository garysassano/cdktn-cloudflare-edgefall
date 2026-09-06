import { stepFootController } from "../../game/controller/foot.js";
import { canonical } from "../../game/core/canonical.js";
import { Edge, type InputCommand } from "../../game/input/types.js";
import {
  type CombatLab,
  advanceCombatLab,
  combatTerrain,
  createCombatLab,
} from "../../game/labs/combat.js";
import { COMBAT_CATALOG, COMBAT_CONTENT, COMBAT_SHAPES } from "../../game/labs/combat-content.js";
import { FOOT_DEFINITION } from "../../game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../../game/physics/grid.js";
import type { ControlledActor } from "../../game/state.js";
import type { PreparedPlayerTick, WorldInputOutcome } from "../protocol/input-stream.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import { PROBE_IDENTITY, createRoomWorkload, roomWorkloadHash } from "./room-workload.js";

export const COMBAT_TERRAIN = combatTerrain("range");
const grid = new CollisionGrid(COMBAT_TERRAIN);
/** Real content digest; simulation/presentation identities remain explicitly diagnostic. */
export async function combatIdentity() {
  const bytes = new TextEncoder().encode(
    canonical({
      content: COMBAT_CONTENT,
      profiles: [...COMBAT_CATALOG.firearms].map(([id, profile]) => ({
        id,
        timelineIds: profile.timelineIds,
      })),
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    ...PROBE_IDENTITY,
    contentHash: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export function combatSnapshot(combat: CombatLab, previous = createRoomWorkload(1)): FullSnapshot {
  const snapshot = structuredClone(previous);
  snapshot.tick = combat.tick;
  snapshot.players = structuredClone(combat.players);
  snapshot.vehicles = [];
  snapshot.platforms = [];
  snapshot.threats = [];
  snapshot.enemies = combat.targets
    .filter((target) => target.health > 0)
    .map(({ enemy, health, shield }) => ({
      id: enemy.body.id,
      definitionId: shield ? 2 : 1,
      x: enemy.body.x,
      y: enemy.body.y,
      vx: enemy.body.vx,
      vy: enemy.body.vy,
      shapeId: enemy.body.shapeId,
      facing: enemy.facing,
      health,
      mode: 0,
      stateStartTick: 0,
      actionInstanceId: 0,
      actionDefinitionId: 0,
      modeTicks: 0,
      supportId: enemy.body.supportId,
      geometryRevision: 1,
    }));
  snapshot.projectiles = combat.projectiles.map((projectile) => ({
    id: projectile.id,
    ownerId: projectile.ownerId,
    actionInstanceId: projectile.actionInstanceId,
    definitionId: projectile.definitionId,
    x: projectile.position.x,
    y: projectile.position.y,
    vx: projectile.velocity.x,
    vy: projectile.velocity.y,
    spawnTick: projectile.spawnTick,
    lifetimeTicks:
      COMBAT_CONTENT.attacks.find((attack) => attack.id === projectile.definitionId)
        ?.lifetimeTicks ?? 0,
    heading:
      projectile.velocity.y < 0
        ? 1
        : projectile.velocity.y > 0
          ? 2
          : projectile.velocity.x < 0
            ? 3
            : 0,
    shapeId: 4,
  }));
  snapshot.removedIds = combat.targets
    .filter((target) => target.health === 0)
    .map((target) => target.enemy.body.id);
  snapshot.campaign.remainingEnemies = combat.targets.filter((target) => target.health > 0).length;
  snapshot.campaign.encounterId = 1;
  snapshot.stateHash = roomWorkloadHash(snapshot);
  return snapshot;
}
export function createCombatWorkload() {
  const combat = createCombatLab("range", 4);
  return { combat, snapshot: combatSnapshot(combat) };
}
export function evaluateCombatTick(
  current: CombatLab,
  previous: FullSnapshot,
  prepared: readonly PreparedPlayerTick[],
) {
  if (current.tick !== previous.tick) throw new Error("Combat/snapshot boundary mismatch");
  const commands = current.players.map((actor) => {
    const item = prepared.find(({ input }) => input.playerId === actor.playerId);
    if (item && item.input.serverTick !== current.tick + 1)
      throw new Error("Combat input tick mismatch");
    return {
      held: item?.input.command.held ?? 0,
      jumpPressed: item?.input.command.edges.some((edge) => edge.kind === Edge.Jump) ?? false,
      firePressed: item?.input.command.edges.some((edge) => edge.kind === Edge.FireOnset) ?? false,
    };
  });
  const result = advanceCombatLab(current, commands);
  const outcomes: WorldInputOutcome[] = prepared.map((item) => {
    const actor = result.state.players.find((player) => player.playerId === item.input.playerId);
    const outcome = result.outcomes.find((value) => value.playerId === item.input.playerId);
    if (!actor || !outcome) throw new Error("Unknown combat input owner");
    actor.processedEdgeIds = [...item.acknowledgment.processedEdgeIds];
    let jump = false,
      fire = false;
    return {
      playerId: actor.playerId,
      edgeResults: item.input.command.edges.map((edge) => {
        let accepted: "applied" | "cooldown" | "unavailable" = "unavailable";
        if (edge.kind === Edge.Jump && !jump) {
          accepted = outcome.jumpAccepted ? "applied" : "unavailable";
          jump = true;
        }
        if (edge.kind === Edge.FireOnset && !fire) {
          accepted = outcome.fire === "none" ? "unavailable" : outcome.fire;
          fire = true;
        } else if (edge.kind === Edge.FireOnset) accepted = "cooldown";
        return { ...edge, outcome: accepted };
      }),
    };
  });
  const snapshot = combatSnapshot(result.state, previous);
  for (const item of prepared) {
    const index = snapshot.acknowledgments.findIndex((ack) => ack.playerId === item.input.playerId);
    if (index < 0) throw new Error("Missing combat acknowledgment");
    snapshot.acknowledgments[index] = structuredClone(item.acknowledgment);
  }
  snapshot.stateHash = roomWorkloadHash(snapshot);
  return { state: { combat: result.state, snapshot }, outcomes };
}
/** Movement prediction only until global action IDs and effect confirmations are integrated. */
export function predictCombatMovement(actor: ControlledActor, command: InputCommand, tick: number) {
  if (!FOOT_DEFINITION) throw new Error("Missing combat foot definition");
  const frame = { tick, geometryRevision: 1 };
  const result = stepFootController(
    actor,
    { held: command.held, jumpPressed: command.edges.some((edge) => edge.kind === Edge.Jump) },
    FOOT_DEFINITION,
    COMBAT_SHAPES,
    new CollisionIndex(grid, [], frame),
    frame,
  );
  if (result.status === "failed") throw new Error(`Combat prediction: ${result.physics.reason}`);
  return result.actor;
}
