import type { CombatLab, CombatTarget } from "../../game/labs/combat.js";
import { RIFLE_PROFILE, SHIELD_PROFILE } from "../../game/labs/combat-content.js";
import type { VehicleState } from "../../game/state.js";
import { type NativeAtlas, nativeExposure } from "./native.js";
import { tankFeedback } from "./tank-feedback.js";
import { type TankMotion, advanceTankMotion, initialTankMotion } from "./tank-motion.js";

export const CAST_ART = [
  { id: "quay-watch", source: "enemies/quay-watch", directory: "enemies" },
  { id: "breakwater", source: "enemies/breakwater", directory: "enemies" },
  { id: "kestrel", source: "vehicles/kestrel", directory: "vehicles" },
] as const;
export type CastId = (typeof CAST_ART)[number]["id"];
export interface CastDrawing {
  texture: CastId;
  frame: string;
  x: number;
  y: number;
  flipX: boolean;
  originX: number;
  originY: number;
  tint?: number;
  tintFill?: boolean;
}
export interface CastMotion {
  tick: number;
  enemies: Array<{ id: number; strideQ: number }>;
  tanks: TankMotion[];
}
export function initialCastMotion(world: CombatLab): CastMotion {
  return {
    tick: world.tick,
    enemies: world.targets.map(({ enemy }) => ({ id: enemy.body.id, strideQ: 0 })),
    tanks: world.tanks.map((tank) => initialTankMotion(tank, world.tick)),
  };
}
/** Accepted movement advances a bounded cosmetic stride; collision contacts alone are not landings. */
export function advanceCastMotion(
  before: CombatLab,
  next: CombatLab,
  current: CastMotion,
): CastMotion {
  if (before.tick !== current.tick || next.tick !== before.tick + 1)
    throw new Error("Cast motion needs one accepted world transition");
  return {
    tick: next.tick,
    enemies: next.targets.map(({ enemy }) => ({
      id: enemy.body.id,
      strideQ:
        ((current.enemies.find((c) => c.id === enemy.body.id)?.strideQ ?? 0) +
          (enemy.life === "alive" && enemy.body.grounded ? Math.abs(enemy.body.vx) : 0)) %
        (18 * 256),
    })),
    tanks: next.tanks.map((tank) =>
      advanceTankMotion(
        before.tanks.find((t) => t.body.id === tank.body.id),
        tank,
        current.tanks.find((c) => c.id === tank.body.id),
        next.tick,
      ),
    ),
  };
}
function sample(atlas: NativeAtlas, id: string, age: number): string {
  const clip = atlas.meta.edgefall.clips.find((clip) => clip.id === id);
  if (!clip) throw new Error(`Missing cast clip ${id}`);
  return nativeExposure(clip, age);
}
function drawing(
  texture: CastId,
  frame: string,
  atlas: NativeAtlas,
  x: number,
  y: number,
  flipX: boolean,
  variant = "base",
): CastDrawing {
  const name = `${variant}/${frame}`,
    size = atlas.frames[name]?.sourceSize;
  if (!size) throw new Error(`Missing cast drawing ${texture}/${name}`);
  return {
    texture,
    frame: name,
    x: Math.round(x / 256),
    y: Math.round(y / 256),
    flipX,
    originX: flipX
      ? 1 - atlas.meta.edgefall.root[0] / size.w
      : atlas.meta.edgefall.root[0] / size.w,
    originY: atlas.meta.edgefall.root[1] / size.h,
  };
}
/** Read accepted phase/integrity and encounter resolution; no client animation callback owns combat. */
export function enemyPresentation(
  target: CombatTarget,
  world: Pick<CombatLab, "tick" | "encounter">,
  atlas: NativeAtlas,
  strideQ: number,
): CastDrawing | null {
  const { enemy, guard, rifle } = target,
    shield = Boolean(guard || target.shield);
  const texture = shield ? "breakwater" : "quay-watch";
  let frame: string;
  if (target.health === 0 || enemy.life === "removed") {
    const resolved = world.encounter.members.find((member) => member.id === enemy.body.id);
    if (
      resolved?.reason !== "killed" ||
      resolved.resolvedTick === null ||
      !enemy.body.grounded ||
      world.tick - resolved.resolvedTick >= 30
    )
      return null;
    frame = sample(
      atlas,
      shield ? "breakwater.death" : "watch.death",
      world.tick - resolved.resolvedTick,
    );
  } else if (!enemy.body.grounded) frame = shield ? "breakwater-fall" : "watch-fall";
  else if (guard) {
    const age = world.tick - guard.action.stateStartTick,
      broken = guard.integrity === 0;
    switch (guard.phase) {
      case "advance":
        frame = sample(
          atlas,
          broken ? "breakwater.walk.broken" : "breakwater.walk",
          Math.floor(strideQ / 256),
        );
        break;
      case "turn":
        frame = broken ? "breakwater-broken-recover" : sample(atlas, "breakwater.turn", age);
        break;
      case "bash":
        frame = sample(atlas, broken ? "breakwater.bash.broken" : "breakwater.bash", age);
        break;
      case "stunned":
        frame = sample(atlas, "breakwater.stunned", age);
        break;
      default:
        frame = broken ? "breakwater-broken" : "breakwater-brace";
    }
  } else if (shield) frame = "breakwater-brace";
  else if (rifle?.action.kind === "fire")
    frame = sample(
      atlas,
      rifle.aim === 1 ? "watch.fire.up" : "watch.fire",
      world.tick - rifle.action.stateStartTick,
    );
  else
    frame =
      enemy.body.vx !== 0 ? sample(atlas, "watch.walk", Math.floor(strideQ / 256)) : "watch-idle";
  return drawing(texture, frame, atlas, enemy.body.x, enemy.body.y, enemy.facing === -1);
}

/** Hull direction, world turret aim and seat clocks are independent presentation inputs. */
export function tankPresentation(
  tank: VehicleState,
  tick: number,
  atlas: NativeAtlas,
  clock: CastMotion["tanks"][number],
  ownerSlot = 0,
): CastDrawing[] {
  const variant = `p${ownerSlot + 1}`;
  const layer = (frame: string, flipX = tank.facing === -1) =>
    drawing("kestrel", frame, atlas, tank.body.x, tank.body.y, flipX, variant);
  if (tank.lifecycle === "wreck") return [layer("kestrel-wreck")];
  const hull = clock.airPhase
    ? sample(atlas, `kestrel.air.${clock.airPhase}`, tick - clock.airPhaseStartTick)
    : clock.landTick !== null && clock.impact
      ? sample(atlas, `kestrel.land-${clock.impact}`, tick - clock.landTick)
      : tank.body.vx !== 0
        ? sample(atlas, "kestrel.suspension", Math.floor(clock.strideQ / 256))
        : "kestrel-hull-idle";
  const track = sample(atlas, "kestrel.drive", Math.floor(clock.strideQ / 256));
  const layers = [layer(`${track}${clock.airPhase ? "-extended" : ""}`), layer(hull)];
  const fireAge = tank.action.kind === "fire" ? tick - tank.action.stateStartTick : -1;
  layers.push(
    layer(
      `kestrel-turret-${tank.heading}${fireAge === 1 ? "-kick" : fireAge === 2 ? "-recoil" : ""}`,
      false,
    ),
  );
  const hatch =
    tank.lifecycle === "boarding" || tank.lifecycle === "exiting"
      ? sample(
          atlas,
          tank.lifecycle === "boarding" ? "kestrel.board" : "kestrel.exit",
          tick - tank.action.stateStartTick,
        )
      : "kestrel-hatch-closed";
  layers.push(layer(hatch));
  const feedback = tankFeedback(tank, tick);
  if (feedback.hitFlash)
    return layers.map((frame) => ({ ...frame, tint: 0xffffff, tintFill: true }));
  const hullLayer = layers[1];
  if (hullLayer && feedback.hullTint !== 0xffffff) hullLayer.tint = feedback.hullTint;
  return layers;
}

export const CAST_TIMING = {
  rifle: { duration: 72, releases: [RIFLE_PROFILE.raiseTicks, 30, RIFLE_PROFILE.lastReleaseTick] },
  shield: {
    duration: 30,
    activeStart: SHIELD_PROFILE.bashActiveTick,
    activeTicks: SHIELD_PROFILE.bashActiveTicks,
  },
} as const;
