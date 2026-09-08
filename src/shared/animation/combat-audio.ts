import type { CombatLab, CombatNotice } from "../../game/labs/combat.js";
import { AREA_PROFILES, TANK_PROFILE } from "../../game/labs/combat-content.js";
import { type NativeAtlas, nativeExposure } from "./native.js";
import type { OperativeMotion } from "./operative-motion.js";
import type { CombatCueName, CombatLoopName } from "./sfx-profile.js";
export interface CombatCue {
  id: string;
  kind: CombatCueName;
  tick: number;
  x: number;
  emitter: string;
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
function eventCue(event: CombatNotice, bossId?: number): CombatCueName | null {
  if (event.kind === "shot") {
    if (event.ownerId === bossId) return "boss-fire";
    switch (event.source?.definitionId) {
      case 2:
        return "hmg";
      case 3:
        return "rifle";
      case 10:
        return "shotgun";
      case 11:
        return null; // The accepted emitter transition owns ignition and persistent roar.
      case 16:
        return "tank";
      case 17:
      case 18:
      case 19:
        return null; // Heavy ordnance and laser audio await their reviewed families.
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
      return "explosion";
    case "prop-destroyed":
      return "wood-break";
    case "shield-break":
      return "shield-break";
    case "killed":
      return event.targetId === bossId ? "boss-destroyed" : "death";
    case "impact":
      if (event.impact?.kind === "shield") return "shield";
      if (event.impact?.entityId === bossId && event.impact?.kind === "body") return "boss-hit";
      return event.impact?.kind === "body" ? "impact-body" : "impact-metal";
    case "muzzle-blocked":
      return "impact-stone";
    default:
      return null;
  }
}
/** Accepted-state transition -> sound intents. Reconstruction may inspect state without playing history. */
export function combatAudioCues(
  before: CombatLab,
  next: CombatLab,
  footfalls: readonly number[] = [],
  bossId?: number,
): CombatCue[] {
  if (next.tick !== before.tick + 1 || before.scenario !== next.scenario)
    throw new Error("Audio needs one accepted world transition");
  const cues: CombatCue[] = [];
  for (const event of next.events) {
    const tank = next.tanks.find((t) => t.body.id === (event.targetId ?? event.impact?.entityId));
    const kind =
      tank && event.kind === "killed"
        ? "tank-destroyed"
        : tank && event.kind === "impact"
          ? "tank-hit"
          : event.kind === "killed" &&
              event.targetId !== bossId &&
              !next.players.some((p) => p.body.id === event.targetId)
            ? "enemy-death"
            : eventCue(event, bossId);
    if (kind)
      cues.push({
        id: `${next.tick}:event:${event.ownerId}:${event.actionInstanceId}:${event.markerIndex}:${event.kind}:${event.targetId ?? event.impact?.colliderId ?? "none"}`,
        kind,
        tick: next.tick,
        x: event.position.x / 256,
        emitter: `actor:${event.ownerId}`,
      });
  }
  for (const player of next.players) {
    const old = before.players.find((value) => value.playerId === player.playerId);
    if (!old) continue;
    let kind: CombatCueName | null = null;
    if (old.life !== "death" && player.life === "death") kind = "death";
    else if (old.life !== "respawning" && player.life === "respawning") kind = "entry";
    else if (player.health < old.health) kind = "hurt";
    else if (old.action.kind !== "enter" && player.action.kind === "enter") kind = "board";
    else if (old.action.kind !== "exit" && player.action.kind === "exit") kind = "exit";
    else if (old.vehicleId !== null && player.vehicleId === null && old.action.kind !== "exit")
      kind = "eject";
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
        emitter: `actor:${player.playerId}`,
      });
  }
  for (const tank of next.tanks) {
    const old = before.tanks.find((value) => value.body.id === tank.body.id);
    if (old && !old.body.grounded && tank.body.grounded)
      cues.push({
        id: `${next.tick}:tank:${tank.body.id}:land`,
        kind: "tank-land",
        tick: next.tick,
        x: tank.body.x / 256,
        emitter: `tank:${tank.body.id}`,
      });
  }
  for (const grenade of next.grenades) {
    const old = before.grenades.find((value) => value.id === grenade.id);
    if (old && grenade.bounces > old.bounces)
      cues.push({
        id: `${next.tick}:grenade:${grenade.id}:bounce:${grenade.bounces}`,
        kind: "grenade-bounce",
        tick: next.tick,
        x: grenade.body.x / 256,
        emitter: `grenade:${grenade.id}`,
      });
  }
  const oldLoops = combatAudioLoops(before),
    loops = combatAudioLoops(next);
  for (const loop of loops)
    if (!oldLoops.some((old) => old.id === loop.id))
      cues.push({
        id: `${next.tick}:${loop.id}:start`,
        kind: loop.kind === "flame" ? "flame-ignite" : "engine-start",
        tick: next.tick,
        x: loop.x,
        emitter: loop.id,
      });
  for (const loop of oldLoops)
    if (!loops.some((next) => next.id === loop.id))
      cues.push({
        id: `${next.tick}:${loop.id}:stop`,
        kind: loop.kind === "flame" ? "flame-tail" : "engine-stop",
        tick: next.tick,
        x: loop.x,
        emitter: loop.id,
      });
  return cues;
}

export interface CombatLoop {
  id: string;
  kind: CombatLoopName;
  x: number;
  rate: number;
}
/** Reconstructable persistent sound from the current accepted state, with no historical one-shots. */
export function combatAudioLoops(
  state: CombatLab,
  disconnected: ReadonlySet<number> = new Set(),
): CombatLoop[] {
  const loops: CombatLoop[] = [];
  for (const tank of state.tanks) {
    if (tank.special.phase === "charging") {
      loops.push({
        id: `charge:${tank.body.id}:${tank.special.actionInstanceId}`,
        kind: "engine",
        x: tank.body.x / 256,
        rate: 1.6,
      });
      continue;
    }
    const player = state.players.find((p) => p.playerId === tank.occupantId);
    if (
      tank.lifecycle !== "occupied" ||
      tank.armor <= 0 ||
      tank.disconnectedTicks > 0 ||
      !player ||
      player.life !== "alive" ||
      player.controlEpoch !== tank.ownerControlEpoch ||
      disconnected.has(player.playerId)
    )
      continue;
    loops.push({
      id: `engine:${tank.body.id}:${tank.controlEpoch}:${player.controlEpoch}`,
      kind: "engine",
      x: tank.body.x / 256,
      rate:
        tank.special.phase === "arming"
          ? 1 + (0.6 * (state.tick - tank.special.startTick + 1)) / TANK_PROFILE.special.armTicks
          : 0.85 + Math.min(0.45, (Math.abs(tank.body.vx) / 256) * 0.13),
    });
  }
  for (const player of state.players) {
    if (
      player.life !== "alive" ||
      player.bodyPresence !== "present" ||
      player.vehicleId !== null ||
      player.weapon.id !== "flamethrower" ||
      disconnected.has(player.playerId)
    )
      continue;
    const active = state.areas.some((area) => {
      const profile = AREA_PROFILES.get(area.definitionId);
      return (
        area.ownerId === player.playerId &&
        area.definitionId === 11 &&
        area.cancelledTick === null &&
        profile &&
        area.lobes.some((lobe) => {
          const emitted = area.startTick + (profile.emissionOffsets[lobe.index] ?? -1000);
          return state.tick >= emitted && state.tick < emitted + profile.attachedTicks;
        })
      );
    });
    if (active)
      loops.push({
        id: `flame:${player.playerId}:${player.controlEpoch}`,
        kind: "flame",
        x: player.body.x / 256,
        rate: 1,
      });
  }
  return loops;
}
