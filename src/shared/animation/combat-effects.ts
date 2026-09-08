import { areaExposures, cardinalRect } from "../../game/combat/area-attack.js";
import type { CombatLab } from "../../game/labs/combat.js";
import { AREA_PROFILES } from "../../game/labs/combat-content.js";
import type { SweepTarget } from "../../game/physics/sweep.js";
import { type NativeAtlas, nativeExposure } from "./native.js";

export const EFFECT_ART = {
  id: "breakwater-fx",
  source: "effects/breakwater-fx",
  directory: "effects",
} as const;
export const EFFECT_BUDGET = 128;
export const EFFECT_POSTROLL = 60;
export interface EffectInstance {
  id: string;
  clip: string;
  born: number;
  lifetime: number;
  x: number;
  y: number;
  flipX: boolean;
  turn: number;
  drift: "still" | "smoke" | "debris-left" | "debris-right";
  priority: number;
}
export interface CombatEffects {
  tick: number;
  items: EffectInstance[];
  discarded: number;
}
export interface EffectMarker {
  id: string;
  kind: "pickup" | "boss-destroyed";
  x: number;
  y: number;
}
export interface EffectDrawing {
  id: string;
  frame: string;
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
  turn: number;
  depth: number;
  alpha: number;
  crop?: { x: number; y: number; w: number; h: number };
}
export function initialEffects(tick = 0): CombatEffects {
  return { tick, items: [], discarded: 0 };
}
const heading = (x: number, y: number) =>
  Math.max(0, Math.min(8, Math.round(4 + (Math.atan2(y, Math.abs(x)) * 8) / Math.PI)));

/** Cosmetic history follows accepted boundaries and can be reconstructed from a recording. */
export function advanceEffects(
  previous: CombatEffects,
  before: CombatLab,
  next: CombatLab,
  markers: readonly EffectMarker[] = [],
): CombatEffects {
  if (next.tick !== before.tick + 1 || previous.tick !== before.tick)
    throw new Error("Effects require consecutive accepted boundaries");
  const items = previous.items.filter((item) => next.tick - item.born < item.lifetime);
  const add = (
    id: string,
    clip: string,
    x: number,
    y: number,
    lifetime: number,
    priority = 1,
    flipX = false,
    turn = 0,
    drift: EffectInstance["drift"] = "still",
  ) =>
    items.push({
      id: `${next.tick}:${id}`,
      clip,
      born: next.tick,
      lifetime,
      x: Math.round(x),
      y: Math.round(y),
      priority,
      flipX,
      turn,
      drift,
    });
  const debris = (id: string, x: number, y: number, material: "wood" | "metal") => {
    for (let i = 0; i < 4; i++)
      add(
        `${id}:${i}`,
        `debris-${material}-${i % 2}`,
        x + (i - 2) * 5,
        y - (i % 2) * 5,
        24,
        0,
        false,
        0,
        i % 2 ? "debris-right" : "debris-left",
      );
  };
  for (const [index, event] of next.events.entries()) {
    const id = `event:${index}:${event.ownerId}:${event.actionInstanceId}:${event.markerIndex}`,
      x = event.position.x / 256,
      y = event.position.y / 256;
    if (event.kind === "shot") {
      const projectile = next.projectiles.find(
        (p) =>
          p.ownerId === event.ownerId &&
          p.actionInstanceId === event.actionInstanceId &&
          p.spawnTick === next.tick,
      );
      const actor = next.players.find((p) => p.playerId === event.ownerId);
      const area = next.areas.find(
        (a) => a.ownerId === event.ownerId && a.actionInstanceId === event.actionInstanceId,
      );
      const direction = area?.lobes.at(-1)?.heading;
      const vx =
          projectile?.velocity.x ??
          (direction === 3 ? -1 : direction === 1 || direction === 2 ? 0 : (actor?.facing ?? 1)),
        vy = projectile?.velocity.y ?? (direction === 1 ? -1 : direction === 2 ? 1 : 0);
      const definition = event.source?.definitionId;
      if (definition === 11) continue;
      const clip =
        definition === 2 || (definition === 16 && vy !== 0)
          ? `hmg-${heading(vx, vy)}`
          : definition === 16
            ? "tank"
            : definition === 10
              ? "shotgun-flash"
              : "sidearm";
      add(
        id,
        clip,
        x,
        y,
        3,
        2,
        vx < 0,
        clip.startsWith("hmg-") ? 0 : vy < 0 ? -90 : vy > 0 ? 90 : 0,
      );
    } else if (event.kind === "impact" || event.kind === "muzzle-blocked") {
      const material =
        event.impact?.kind === "shield" ||
        next.tanks.some((tank) => tank.body.id === event.impact?.entityId)
          ? "metal"
          : event.impact?.kind === "body"
            ? "body"
            : "stone";
      add(id, `impact-${material}`, x, y, 8, 2);
    } else if (event.kind === "explosion" || event.kind === "prop-destroyed") {
      add(id, "blast", x, y, 30, 3);
      debris(`${id}:debris`, x, y, event.kind === "prop-destroyed" ? "wood" : "metal");
    } else if (event.kind === "shield-break") {
      add(id, "impact-metal", x, y, 8, 3);
      debris(`${id}:shield`, x, y, "metal");
    }
  }
  for (const player of next.players) {
    const old = before.players.find((p) => p.playerId === player.playerId);
    if (old && !old.body.grounded && player.body.grounded && player.life === "alive")
      add(`land:${player.playerId}`, "dust", player.body.x / 256, player.body.y / 256, 8);
  }
  for (const tank of next.tanks) {
    const old = before.tanks.find((t) => t.body.id === tank.body.id),
      x = tank.body.x / 256,
      y = tank.body.y / 256;
    if (
      old &&
      old.lifecycle !== "wreck" &&
      tank.lifecycle === "wreck" &&
      !next.events.some(
        (event) =>
          event.kind === "explosion" &&
          event.source &&
          "sourceId" in event.source &&
          event.source.sourceId === tank.body.id,
      )
    ) {
      add(`wreck:${tank.body.id}`, "blast", x, y - 18, 30, 3);
      debris(`wreck:${tank.body.id}`, x, y - 18, "metal");
    } else if (tank.armor > 0 && tank.armor <= 1 && next.tick % 12 === 0)
      add(
        `exhaust:${tank.body.id}`,
        "smoke",
        x - tank.facing * 20,
        y - 23,
        24,
        1,
        false,
        0,
        "smoke",
      );
    if (old && !old.body.grounded && tank.body.grounded)
      add(`tank-land:${tank.body.id}`, "dust", x, y, 8, 2);
  }
  for (const marker of markers) {
    const boss = marker.kind === "boss-destroyed";
    add(marker.id, boss ? "blast" : "pickup", marker.x, marker.y, boss ? 30 : 8, boss ? 3 : 1);
    if (boss) {
      add(`${marker.id}:upper`, "blast", marker.x + 28, marker.y - 36, 30, 3);
      add(`${marker.id}:smoke`, "smoke", marker.x - 18, marker.y - 22, 24, 1, false, 0, "smoke");
      debris(marker.id, marker.x, marker.y, "metal");
    }
  }
  // Discard older decorative debris/smoke first; finite lifetime and a hard budget
  // apply even under simultaneous four-player fire. No discarded item owns damage.
  items.sort(
    (a, b) =>
      b.priority - a.priority || b.born - a.born || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    tick: next.tick,
    items: items.slice(0, EFFECT_BUDGET),
    discarded: previous.discarded + Math.max(0, items.length - EFFECT_BUDGET),
  };
}

/** Native sprites only; post-roll samples cosmetic age without advancing the terminal world. */
export function effectDrawings(
  state: CombatEffects,
  world: CombatLab,
  atlas: NativeAtlas,
  terrain: readonly SweepTarget[],
  tick = world.tick,
  reduced = false,
  terminal = false,
): EffectDrawing[] {
  if (!Number.isSafeInteger(tick) || tick < state.tick || state.tick !== world.tick)
    throw new Error("Invalid effect presentation tick");
  const drawings: EffectDrawing[] = [];
  const draw = (
    id: string,
    frame: string,
    x: number,
    y: number,
    flipX = false,
    turn = 0,
    depth = 2,
    alpha = 1,
    flipY = false,
    crop?: EffectDrawing["crop"],
  ) => {
    if (!atlas.frames[`base/${frame}`]) throw new Error(`Missing effect drawing ${frame}`);
    drawings.push({
      id,
      frame: `base/${frame}`,
      x: Math.round(x),
      y: Math.round(y),
      flipX,
      flipY,
      turn,
      depth,
      alpha,
      ...(crop ? { crop } : {}),
    });
  };
  for (const item of state.items) {
    const age = tick - item.born;
    if (age >= item.lifetime || (reduced && item.priority === 0)) continue;
    const clip = atlas.meta.edgefall.clips.find((c) => c.id === item.clip);
    const frame = clip ? nativeExposure(clip, age) : item.clip;
    const drift = item.drift.startsWith("debris");
    const x = item.x + (drift ? Math.floor(age * (item.drift === "debris-left" ? -1 : 1)) : 0),
      y =
        item.y +
        (drift
          ? Math.floor(-age * 1.8 + (age * age) / 16)
          : item.drift === "smoke"
            ? -Math.floor(age / 2)
            : 0);
    draw(
      item.id,
      frame,
      x,
      y,
      item.flipX,
      item.turn,
      item.clip === "smoke" ? 0.9 : 2,
      reduced && item.clip === "blast" ? 0.65 : 1,
    );
  }
  if (terminal) return drawings;
  for (const projectile of world.projectiles)
    draw(
      `projectile:${projectile.id}`,
      `tracer-${projectile.team === 2 ? "hostile" : "ally"}-${heading(projectile.velocity.x, projectile.velocity.y)}`,
      projectile.position.x / 256,
      projectile.position.y / 256,
      projectile.velocity.x < 0,
    );
  for (const grenade of world.grenades)
    draw(
      `grenade:${grenade.body.id}`,
      `grenade-${Math.floor(tick / 4) % 4}`,
      grenade.body.x / 256,
      grenade.body.y / 256,
    );
  for (const attack of world.areas) {
    const profile = AREA_PROFILES.get(attack.definitionId);
    if (!profile) continue;
    for (const exposure of areaExposures(attack, world.tick, profile, terrain)) {
      const lobe = attack.lobes.find((l) => l.index === exposure.lobe),
        age = world.tick - exposure.spawnTick,
        geometry = profile.frames[age];
      if (!lobe || !geometry) throw new Error("Missing accepted area geometry");
      const full = cardinalRect(lobe.origin, geometry, exposure.heading),
        cx = Math.round((full.x + full.w / 2) / 256),
        cy = Math.round((full.y + full.h / 2) / 256);
      const points = [
        [exposure.rect.x, exposure.rect.y],
        [exposure.rect.x + exposure.rect.w, exposure.rect.y + exposure.rect.h],
      ].map(([x = 0, y = 0]) => {
        const dx = x / 256 - cx,
          dy = y / 256 - cy;
        return exposure.heading === 0
          ? [dx, dy]
          : exposure.heading === 3
            ? [-dx, dy]
            : exposure.heading === 1
              ? [-dy, dx]
              : [dy, dx];
      });
      const left = Math.max(0, Math.ceil(64 + Math.min(...points.map((p) => p[0] ?? 0)))),
        top = Math.max(0, Math.ceil(64 + Math.min(...points.map((p) => p[1] ?? 0)))),
        right = Math.min(128, Math.floor(64 + Math.max(...points.map((p) => p[0] ?? 0)))),
        bottom = Math.min(128, Math.floor(64 + Math.max(...points.map((p) => p[1] ?? 0))));
      if (right <= left || bottom <= top) continue;
      draw(
        `area:${attack.id}:${exposure.lobe}`,
        attack.definitionId === 10
          ? `shot-blast-${age}`
          : `flame-${age < 6 ? age : 3 + ((age - 6) % 3)}`,
        cx,
        cy,
        exposure.heading === 3,
        exposure.heading === 1 ? -90 : exposure.heading === 2 ? 90 : 0,
        2,
        reduced ? 0.75 : 1,
        exposure.heading === 2,
        { x: left, y: top, w: right - left, h: bottom - top },
      );
    }
  }
  return drawings;
}
