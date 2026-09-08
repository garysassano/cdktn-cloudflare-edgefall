import { type SurfaceMaterialId, materialDamage, surfaceMaterial } from "../content/materials.js";
import type { AttackDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer } from "../core/numeric.js";
import type { Body, Rect } from "../state.js";
import type { HurtTarget, Impact } from "./projectile.js";

export interface DestructibleDefinition {
  id: number;
  definitionId: number;
  rect: Rect;
  health: number;
  materialId: SurfaceMaterialId;
}
export interface DestructibleState {
  id: number;
  definitionId: number;
  health: number;
  destroyedTick: number | null;
  destroyerId: number | null;
  destroyActionId: number | null;
}
export function createDestructible(definition: DestructibleDefinition): DestructibleState {
  surfaceMaterial(definition.materialId);
  return {
    id: definition.id,
    definitionId: definition.definitionId,
    health: definition.health,
    destroyedTick: null,
    destroyerId: null,
    destroyActionId: null,
  };
}
export function destructibleHurtboxes(
  props: readonly DestructibleState[],
  definitions: readonly DestructibleDefinition[],
): HurtTarget[] {
  return props
    .filter((prop) => prop.health > 0)
    .map((prop) => {
      const definition = definitions.find((definition) => definition.id === prop.id);
      if (!definition || definition.definitionId !== prop.definitionId)
        throw new Error("Missing destructible geometry");
      return {
        id: prop.id,
        entityId: prop.id,
        team: 0,
        kind: "body",
        solid: true,
        materialId: definition.materialId,
        rect: { ...definition.rect },
        delta: { x: 0, y: 0 },
      };
    });
}
/** A committed material hit owns destruction; environmental falls do not invent kill credit. */
export function damageDestructible(
  prop: DestructibleState,
  definition: DestructibleDefinition,
  impact: Impact,
  attack: AttackDefinition,
  tick: number,
): boolean {
  if (definition.id !== prop.id || definition.definitionId !== prop.definitionId)
    throw new Error("Destructible material identity mismatch");
  surfaceMaterial(definition.materialId);
  if (prop.health === 0 || impact.damage === 0) return false;
  if (impact.entityId !== prop.id || impact.kind !== "body" || impact.definitionId !== attack.id)
    throw new Error("Destructible damage identity mismatch");
  integer(impact.damage, 1, attack.damage, "destructible damage");
  prop.health = Math.max(
    0,
    prop.health - materialDamage(impact.damage, attack.material, definition.materialId),
  );
  if (prop.health > 0) return false;
  prop.destroyedTick = tick;
  prop.destroyerId = impact.ownerId;
  prop.destroyActionId = impact.actionInstanceId;
  return true;
}
/** Removing support changes contacts, never position or velocity. Gravity acts next tick. */
export function detachDestroyedSupport(body: Body, removed: ReadonlySet<number>): boolean {
  const detached = body.supportId !== null && removed.has(body.supportId);
  if (detached) {
    body.supportId = null;
    body.grounded = false;
  }
  body.contacts = body.contacts.filter((contact) => !removed.has(contact.otherId));
  return detached;
}
export function validateDestructibles(
  props: readonly DestructibleState[],
  definitions: readonly DestructibleDefinition[],
  tick: number,
  ownerIds: readonly number[],
  nextActionId: number,
) {
  if (props.length !== definitions.length || props.length > 32)
    throw new Error("Destructible roster mismatch");
  for (const [index, prop] of props.entries()) {
    const definition = definitions[index];
    if (!definition || prop.id !== definition.id || prop.definitionId !== definition.definitionId)
      throw new Error("Destructible definition mismatch");
    surfaceMaterial(definition.materialId);
    integer(prop.health, 0, definition.health, "destructible health");
    if (prop.health > 0) {
      if (prop.destroyedTick !== null || prop.destroyerId !== null || prop.destroyActionId !== null)
        throw new Error("Live prop has destruction attribution");
    } else {
      integer(prop.destroyedTick as number, 1, tick, "destruction tick");
      integer(prop.destroyActionId as number, 1, nextActionId - 1, "destruction action");
      integer(prop.destroyerId as number, 1, COUNTER_LIMIT - 1, "destruction owner");
      if (!ownerIds.includes(prop.destroyerId as number))
        throw new Error("Unknown destruction owner");
    }
  }
}
