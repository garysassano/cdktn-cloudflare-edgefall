import { type EnemyGrenadeIntent, grenadierReleaseClear } from "../actors/grenadier.js";
import { motion, nextCounter } from "../core/numeric.js";
import { worldSocket } from "../physics/body.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { CombatLab } from "./combat.js";
import { COMBAT_SHAPES, GRENADE_PROFILE } from "./combat-content.js";

/** Emit after accepted enemy locomotion. A moving ceiling or a crush can cancel this release. */
export function appendEnemyGrenades(
  world: CombatLab,
  intents: readonly EnemyGrenadeIntent[],
  terrain: readonly SweepTarget[],
) {
  if (new Set(intents.map((intent) => intent.ownerId)).size !== intents.length)
    throw new Error("Duplicate enemy grenade release owner");
  const shape = COMBAT_SHAPES.get(GRENADE_PROFILE.bodyShapeId);
  if (!shape) throw new Error("Missing enemy grenade shape");
  const endTerrain = terrain.map((surface) => ({
    ...surface,
    rect: {
      ...surface.rect,
      x: surface.rect.x + surface.delta.x,
      y: surface.rect.y + surface.delta.y,
    },
    delta: { x: 0, y: 0 },
  }));
  for (const intent of [...intents].sort((a, b) => a.ownerId - b.ownerId)) {
    const target = world.targets.find((target) => target.enemy.body.id === intent.ownerId);
    if (
      !target ||
      intent.releaseTick !== world.tick ||
      intent.actionInstanceId < 1 ||
      intent.actionInstanceId >= world.nextActionId
    )
      throw new Error("Unallocated enemy grenade owner/action");
    if (target.health === 0 || target.enemy.life !== "alive" || !target.enemy.body.grounded)
      continue;
    const clear = grenadierReleaseClear(
      target.enemy.body,
      intent.facing,
      intent.hand,
      intent.release,
      shape,
      endTerrain,
    );
    const position = worldSocket(target.enemy.body, intent.release, intent.facing);
    world.events.push({
      kind: clear ? "throw" : "muzzle-blocked",
      ownerId: intent.ownerId,
      actionInstanceId: intent.actionInstanceId,
      markerIndex: 0,
      source: { definitionId: 5, timelineId: 0, stateStartTick: intent.stateStartTick },
      position,
      impact: null,
      targetId: null,
      beam: null,
    });
    if (!clear) continue;
    const id = world.nextEntityId;
    world.nextEntityId = nextCounter(id);
    world.grenades.push({
      id,
      ownerId: intent.ownerId,
      team: 2,
      actionInstanceId: intent.actionInstanceId,
      definitionId: 5,
      spawnTick: world.tick,
      bounces: 0,
      body: {
        id,
        x: position.x,
        y: position.y,
        vx: motion(intent.velocity.x),
        vy: motion(intent.velocity.y),
        remainderX: 0,
        remainderY: 0,
        shapeId: shape.id,
        supportId: null,
        grounded: false,
        contacts: [],
      },
    });
  }
}
