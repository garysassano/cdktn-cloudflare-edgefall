import type { BreakwaterMission } from "../../game/missions/breakwater.js";
import { BREAKWATER } from "../../game/missions/breakwater-content.js";
import { type CombatCue, combatAudioCues } from "./combat-audio.js";
import {
  type CombatEffects,
  type EffectMarker,
  advanceEffects,
  initialEffects,
} from "./combat-effects.js";

export const BREAKWATER_ART = [
  { id: "breakwater-quay", source: "environment/breakwater-quay", directory: "environment" },
  { id: "lock-engine", source: "bosses/lock-engine", directory: "bosses" },
] as const;

export interface BreakwaterVisual {
  bossHitTick: number | null;
  effects: CombatEffects;
}
export function breakwaterAudioCues(
  before: BreakwaterMission,
  next: BreakwaterMission,
  footfalls: readonly number[] = [],
): CombatCue[] {
  const cues = combatAudioCues(before.combat, next.combat, footfalls, BREAKWATER.boss.id);
  if (before.boss.phase !== "windup" && next.boss.phase === "windup")
    cues.push({
      id: `${next.combat.tick}:boss:${next.boss.actionInstanceId}:warning`,
      kind: "boss-warning",
      tick: next.combat.tick,
      x: BREAKWATER.boss.x,
      emitter: "boss",
    });
  for (const notice of next.notices) {
    const player =
      next.combat.players.find((p) => p.playerId === notice.playerId) ?? next.combat.players[0];
    if (!player) throw new Error("Missing mission audio listener");
    cues.push({
      id: `${notice.tick}:mission:${notice.kind}:${notice.id}:${notice.playerId}`,
      kind: notice.kind,
      tick: notice.tick,
      x: player.body.x / 256,
      emitter: `mission:${notice.playerId ?? "all"}`,
    });
  }
  return cues;
}
export function initialBreakwaterVisual(tick = 0): BreakwaterVisual {
  return { bossHitTick: null, effects: initialEffects(tick) };
}
export function advanceBreakwaterVisual(
  previous: BreakwaterVisual,
  before: BreakwaterMission,
  next: BreakwaterMission,
): BreakwaterVisual {
  const markers: EffectMarker[] = [];
  for (const notice of next.notices) {
    if (notice.kind !== "pickup") continue;
    const cache = BREAKWATER.pickups.find((p) => p.id === notice.id);
    if (cache)
      markers.push({
        id: `pickup:${notice.id}:${notice.playerId}`,
        kind: "pickup",
        x: cache.x,
        y: cache.y - 12,
      });
  }
  if (before.boss.health > 0 && next.boss.health === 0)
    markers.push({
      id: "boss-destroyed",
      kind: "boss-destroyed",
      x: BREAKWATER.boss.x,
      y: BREAKWATER.boss.y - 24,
    });
  return {
    bossHitTick: next.boss.health < before.boss.health ? next.combat.tick : previous.bossHitTick,
    effects: advanceEffects(previous.effects, before.combat, next.combat, markers),
  };
}
