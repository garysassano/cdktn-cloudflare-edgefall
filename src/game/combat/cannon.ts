import type { MaterialSurface } from "../content/materials.js";
import type { AttackDefinition, ShapeDefinition } from "../content/schema.js";
import { integer, motion, position } from "../core/numeric.js";
import { type BallisticProjectile, type HurtTarget, projectileImpact } from "./projectile.js";
import { explosionHits } from "./volume.js";

/** One accepted linear flight step; released shells survive seat changes and hull destruction. */
export function stepCannonShell(
  shell: BallisticProjectile,
  tick: number,
  definition: AttackDefinition,
  body: ShapeDefinition,
  radius: number,
  terrain: readonly MaterialSurface[],
  hurtboxes: readonly HurtTarget[],
) {
  if (
    definition.id !== shell.definitionId ||
    definition.kind !== "explosion" ||
    definition.material !== "explosive" ||
    definition.repeatDamageTicks !== 0
  )
    throw new Error("Invalid cannon shell policy");
  integer(tick - shell.spawnTick, 1, definition.lifetimeTicks, "cannon flight age");
  integer(radius, 1, 2 ** 16, "cannon blast radius");
  for (const extent of [
    body.rect.x,
    body.rect.y,
    body.rect.x + body.rect.w,
    body.rect.y + body.rect.h,
  ])
    integer(extent, -radius, radius, "cannon body inside blast");
  const contact = projectileImpact(shell, body, 0, terrain, hurtboxes);
  if (contact)
    return {
      status: "detonated" as const,
      contact,
      impacts: explosionHits(shell, definition, contact.position, radius, terrain, hurtboxes, {
        time: contact.time,
        primaryTarget: contact.entityId,
      }),
    };
  const next = {
    ...shell,
    position: {
      x: position(shell.position.x + motion(shell.velocity.x)),
      y: position(shell.position.y + motion(shell.velocity.y)),
    },
  };
  return tick - shell.spawnTick === definition.lifetimeTicks
    ? { status: "expired" as const, position: next.position }
    : { status: "active" as const, shell: next };
}
