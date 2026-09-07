import type { CombatLab, CombatNotice } from "../../game/labs/combat.js";
import { type NativeAtlas, nativeExposure } from "./native.js";
import type { OperativeMotion } from "./operative-motion.js";

export const COMBAT_AUDIO = {
  sidearm: { file: "carbine-shot.ogg", gain: 0.45, rate: 1.1 },
  hmg: { file: "rivet-shot.ogg", gain: 0.32, rate: 1.05 },
  rifle: { file: "carbine-shot.ogg", gain: 0.38, rate: 0.72 },
  shotgun: { file: "scatter-shot.ogg", gain: 0.65, rate: 0.84 },
  flame: { file: "beam-loop.ogg", gain: 0.3, rate: 0.64 },
  tank: { file: "rivet-shot.ogg", gain: 0.58, rate: 0.66 },
  knife: { file: "melee.ogg", gain: 0.5, rate: 1 },
  bash: { file: "impact-light.ogg", gain: 0.6, rate: 0.45 },
  throw: { file: "footstep-b.ogg", gain: 0.3, rate: 1.5 },
  explosion: { file: "explosion.ogg", gain: 0.8, rate: 0.85 },
  shield: { file: "impact-light.ogg", gain: 0.55, rate: 1.65 },
  break: { file: "explosion.ogg", gain: 0.45, rate: 1.8 },
  impact: { file: "impact-light.ogg", gain: 0.3, rate: 1 },
  death: { file: "player-hit.ogg", gain: 0.55, rate: 0.7 },
  entry: { file: "reward.ogg", gain: 0.25, rate: 0.75 },
  step: { file: "footstep-a.ogg", gain: 0.1, rate: 1 },
  jump: { file: "footstep-b.ogg", gain: 0.2, rate: 1.2 },
  land: { file: "footstep-b.ogg", gain: 0.35, rate: 0.75 },
  board: { file: "impact-light.ogg", gain: 0.38, rate: 0.65 },
} as const;
export type CombatCueName = keyof typeof COMBAT_AUDIO;
export interface CombatCue {
  id: string;
  kind: CombatCueName;
  tick: number;
  x: number;
}
/** A planted foot changes at an authored stride contact, independent of the global tick origin. */
export function operativeFootfalls(
  motion: readonly OperativeMotion[],
  atlas: NativeAtlas,
): number[] {
  const clip = atlas.meta.edgefall.clips.find((c) => c.id === "legs.run");
  if (!clip) throw new Error("Missing operative run contacts");
  return motion
    .filter((clock) => {
      const age = clock.tick - clock.runStartTick;
      if (clock.mode !== "run" || clock.transition !== null || age < 0) return false;
      const frame = nativeExposure(clip, age),
        previous = age > 0 ? nativeExposure(clip, age - 1) : null;
      return (
        atlas.meta.edgefall.drawings[frame]?.contact?.foot !==
        (previous ? atlas.meta.edgefall.drawings[previous]?.contact?.foot : undefined)
      );
    })
    .map((clock) => clock.playerId);
}
function eventCue(event: CombatNotice): CombatCueName | null {
  if (event.kind === "shot") {
    switch (event.source?.definitionId) {
      case 2:
        return "hmg";
      case 3:
        return "rifle";
      case 10:
        return "shotgun";
      case 11:
        return "flame";
      case 16:
        return "tank";
      default:
        return "sidearm";
    }
  }
  switch (event.kind) {
    case "melee":
      return event.source?.definitionId === 6 ? "bash" : "knife";
    case "throw":
      return "throw";
    case "explosion":
    case "prop-destroyed":
      return "explosion";
    case "shield-break":
      return "break";
    case "killed":
      return "death";
    case "impact":
      return event.impact?.kind === "shield" ? "shield" : "impact";
    case "muzzle-blocked":
      return "impact";
    default:
      return null;
  }
}
/** Accepted-state transition -> sound intents. Reconstruction may inspect state without playing history. */
export function combatAudioCues(
  before: CombatLab,
  next: CombatLab,
  footfalls: readonly number[] = [],
): CombatCue[] {
  if (next.tick !== before.tick + 1 || before.scenario !== next.scenario)
    throw new Error("Audio needs one accepted world transition");
  const cues: CombatCue[] = [];
  for (const event of next.events) {
    const kind = eventCue(event);
    if (kind)
      cues.push({
        id: `${next.tick}:event:${event.ownerId}:${event.actionInstanceId}:${event.markerIndex}:${event.kind}:${event.targetId ?? event.impact?.colliderId ?? "none"}`,
        kind,
        tick: next.tick,
        x: event.position.x / 256,
      });
  }
  for (const player of next.players) {
    const old = before.players.find((value) => value.playerId === player.playerId);
    if (!old) continue;
    let kind: CombatCueName | null = null;
    if (old.life !== "death" && player.life === "death") kind = "death";
    else if (old.life !== "respawning" && player.life === "respawning") kind = "entry";
    else if (
      old.vehicleId !== player.vehicleId ||
      (old.action.kind !== "enter" && player.action.kind === "enter")
    )
      kind = "board";
    else if (player.life === "alive" && player.vehicleId === null) {
      if (!old.body.grounded && player.body.grounded) kind = "land";
      else if (old.body.grounded && !player.body.grounded && player.body.vy < 0) kind = "jump";
      else if (player.body.grounded && player.body.vx !== 0 && footfalls.includes(player.playerId))
        kind = "step";
    }
    if (
      kind &&
      !(
        kind === "death" &&
        next.events.some((e) => e.kind === "killed" && e.targetId === player.body.id)
      )
    )
      cues.push({
        id: `${next.tick}:player:${player.playerId}:${kind}`,
        kind,
        tick: next.tick,
        x: player.body.x / 256,
      });
  }
  for (const tank of next.tanks) {
    const old = before.tanks.find((value) => value.body.id === tank.body.id);
    if (old && !old.body.grounded && tank.body.grounded)
      cues.push({
        id: `${next.tick}:tank:${tank.body.id}:land`,
        kind: "land",
        tick: next.tick,
        x: tank.body.x / 256,
      });
  }
  return cues;
}
