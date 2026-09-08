import Phaser from "phaser";
import { rifleMode } from "../game/actors/rifle.js";
import { shieldMode, shieldPresentation } from "../game/actors/shield.js";
import { areaExposures } from "../game/combat/area-attack.js";
import { beamExposures } from "../game/combat/beam.js";
import { firearmPoseTimeline } from "../game/combat/firearm-aim.js";
import { actionPose } from "../game/combat/timeline.js";
import { LASER_PROFILE } from "../game/content/weapons/laser.js";
import {
  ROCKET_ATTACK,
  ROCKET_PROFILE,
  ROCKET_SHAPE,
} from "../game/content/weapons/rocket-launcher.js";
import { canonical } from "../game/core/canonical.js";
import { Held } from "../game/input/types.js";
import {
  COMBAT_LAB_LIMIT,
  COMBAT_SCENARIOS,
  type CombatCommand,
  type CombatLab,
  type CombatRecording,
  combatHurtboxes,
  combatTerrain,
  createCombatLab,
  replayCombatLab,
  stepCombatLab,
} from "../game/labs/combat.js";
import {
  AREA_PROFILES,
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  GRENADE_PROFILE,
  RIFLE_PROFILE,
  SHIELD_PROFILE,
} from "../game/labs/combat-content.js";
import { combatPickupDefinitions } from "../game/labs/combat-pickups.js";
import { combatEndTerrain } from "../game/labs/combat-terrain.js";
import { worldRect, worldSocket } from "../game/physics/body.js";
import {
  type CastDrawing,
  advanceCastMotion,
  initialCastMotion,
} from "../shared/animation/cast.js";
import { combatAudioCues, operativeFootfalls } from "../shared/animation/combat-audio.js";
import type { NativeAtlas } from "../shared/animation/native.js";
import {
  type OperativeMotion,
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../shared/animation/operative-motion.js";
import { CastAudio } from "./cast-audio.js";
import { NativeCast } from "./native-cast.js";
import { NativeOperative } from "./native-operative.js";
import { PickupOverlay } from "./pickup-overlay.js";
import { drawTankOverlay } from "./tank-overlay.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing combat control ${id}`);
  return value as T;
}
const surface = element("game"),
  scenarios = element<HTMLSelectElement>("scenario"),
  players = element<HTMLSelectElement>("players");
for (const scenario of COMBAT_SCENARIOS) scenarios.add(new Option(scenario, scenario));
let state = createCombatLab("range"),
  commands: CombatCommand[][] = [],
  playback: CombatCommand[][] | null = null,
  running = false,
  accumulator = 0,
  jump = false,
  grenade = false,
  interact = false,
  fire = false;
const keys = new Set<string>();
const audio = new CastAudio();
let castFrames: CastDrawing[] = [];
let supplyMarkers: ReturnType<PickupOverlay["draw"]> = [];
let castMotion = initialCastMotion(state);
let nativeFrames: ReturnType<NativeOperative["draw"]> = [];
let nativeAtlas: NativeAtlas | undefined;
let motion = state.players.map((player) => initialOperativeMotion(player, state.tick));
function nextMotion(before: CombatLab, next: CombatLab, current: OperativeMotion[]) {
  return next.players.map((player, slot) => {
    const old = before.players[slot],
      clock = current[slot];
    return nativeAtlas && old && clock
      ? advanceOperativeMotion(old, player, clock, next.tick, nativeAtlas)
      : initialOperativeMotion(player, next.tick);
  });
}
function replayWithMotion(recording: CombatRecording) {
  let previous: CombatLab | undefined,
    castClocks = initialCastMotion(createCombatLab(recording.scenario, recording.players)),
    clocks: OperativeMotion[] = [];
  const restored = replayCombatLab(recording, (boundary) => {
    castClocks = previous
      ? advanceCastMotion(previous, boundary, castClocks)
      : initialCastMotion(boundary);
    clocks = previous
      ? nextMotion(previous, boundary, clocks)
      : boundary.players.map((player) => initialOperativeMotion(player, boundary.tick));
    previous = boundary;
  });
  return { state: restored, motion: clocks, castMotion: castClocks };
}
const bindings: Record<string, number> = {
  ArrowLeft: Held.Left,
  KeyA: Held.Left,
  ArrowRight: Held.Right,
  KeyD: Held.Right,
  ArrowUp: Held.Up,
  KeyW: Held.Up,
  ArrowDown: Held.Down,
  KeyS: Held.Down,
  KeyZ: Held.Fire,
};
function inspect(message = "") {
  element("state").textContent = JSON.stringify(state, null, 2);
  element("status").textContent =
    `Tick ${state.tick} · ${state.encounter.phase} · ${running ? "running" : "paused"} · ${state.players.map((player) => `P${player.slot + 1}: ${player.lives} lives, ${player.grenadeStock} grenades, ${player.life}`).join(" · ")}${message ? ` · ${message}` : ""}`;
}
function pause() {
  audio.hush();
  running = false;
  accumulator = 0;
  keys.clear();
  jump = fire = grenade = interact = false;
  element("run").textContent = "Run";
}
function step() {
  if (playback && state.tick === playback.length) {
    playback = null;
    pause();
    inspect("playback complete");
    return;
  }
  if (state.tick >= COMBAT_LAB_LIMIT) {
    pause();
    inspect("recording limit");
    return;
  }
  const command = {
    held: [...keys].reduce((mask, key) => mask | (bindings[key] ?? 0), 0),
    jumpPressed: jump,
    firePressed: fire,
    grenadePressed: grenade,
    interactPressed: interact,
  };
  jump = fire = grenade = interact = false;
  const inputs =
    playback?.[state.tick] ??
    state.players.map((_, slot) =>
      slot === 0
        ? command
        : {
            held: element<HTMLInputElement>("assist").checked ? Held.Fire : 0,
            jumpPressed: false,
            firePressed: false,
            grenadePressed: false,
            interactPressed: false,
          },
    );
  try {
    const next = stepCombatLab(state, inputs),
      clocks = nextMotion(state, next, motion);
    audio.consume(
      next,
      combatAudioCues(state, next, nativeAtlas ? operativeFootfalls(clocks, nativeAtlas) : []),
      running,
    );
    castMotion = advanceCastMotion(state, next, castMotion);
    state = next;
    motion = clocks;
    commands.push(inputs);
    inspect();
  } catch (error) {
    pause();
    inspect(`stopped: ${error}`);
  }
}
function reset() {
  pause();
  audio.reset();
  playback = null;
  commands = [];
  state = createCombatLab(
    COMBAT_SCENARIOS.find((scenario) => scenario === scenarios.value) ?? "range",
    Number(players.value),
  );
  motion = state.players.map((player) => initialOperativeMotion(player, state.tick));
  castMotion = initialCastMotion(state);
  inspect();
}
function recording(): CombatRecording {
  return {
    format: 12,
    scenario: state.scenario,
    players: state.players.length,
    commands,
    finalState: canonical(state),
  };
}
for (const button of document.querySelectorAll("button"))
  button.addEventListener("pointerdown", (event) => event.preventDefault());
surface.addEventListener("keydown", (event) => {
  if (event.code === "Enter") {
    event.preventDefault();
    if (!event.repeat && !running) step();
    return;
  }
  if (
    !(event.code in bindings) &&
    event.code !== "Space" &&
    event.code !== "KeyC" &&
    event.code !== "KeyE"
  )
    return;
  event.preventDefault();
  if (event.repeat) return;
  if (!keys.has(event.code)) {
    if (event.code === "KeyE") interact = true;
    if (event.code === "Space") jump = true;
    if (event.code === "KeyZ") fire = true;
    if (event.code === "KeyC") grenade = true;
  }
  keys.add(event.code);
});
surface.addEventListener("keyup", (event) => {
  if (event.code in bindings || event.code === "Space" || event.code === "KeyC")
    event.preventDefault();
  keys.delete(event.code);
});
surface.addEventListener("blur", () => {
  pause();
  inspect();
});
window.addEventListener("blur", () => {
  pause();
  inspect();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pause();
    inspect();
  }
});
element("reset").onclick = reset;
scenarios.onchange = players.onchange = reset;
element("step").onclick = step;
element("run").onclick = () => {
  if (running) pause();
  else {
    running = true;
    audio.resume(state);
    element("run").textContent = "Pause";
    surface.focus();
  }
  inspect();
};
element("replay").onclick = () => {
  pause();
  playback = null;
  try {
    const replayed = replayWithMotion(recording());
    state = replayed.state;
    motion = replayed.motion;
    castMotion = replayed.castMotion;
    audio.reset();
    inspect("replay matches");
  } catch (error) {
    inspect(`replay failed: ${error}`);
  }
};
element("play-recording").onclick = () => {
  pause();
  if (commands.length === 0) {
    inspect("record some input first");
    return;
  }
  playback = structuredClone(commands);
  state = createCombatLab(state.scenario, state.players.length);
  castMotion = initialCastMotion(state);
  motion = state.players.map((player) => initialOperativeMotion(player, state.tick));
  commands = [];
  audio.reset();
  running = true;
  audio.resume(state);
  element("run").textContent = "Pause";
  surface.focus();
  inspect("playing recorded input");
};
element("export").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(recording(), null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "edgefall-combat-recording.json";
  link.click();
  URL.revokeObjectURL(url);
};
element<HTMLInputElement>("import").onchange = async (event) => {
  pause();
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || file.size > 2_000_000) throw new Error("Recording missing or too large");
    const imported: CombatRecording = JSON.parse(await file.text());
    const restored = replayWithMotion(imported);
    state = restored.state;
    motion = restored.motion;
    castMotion = restored.castMotion;
    commands = imported.commands;
    playback = null;
    audio.reset();
    scenarios.value = state.scenario;
    players.value = String(state.players.length);
    inspect("imported replay matches");
  } catch (error) {
    inspect(`import rejected: ${error}`);
  }
};
element<HTMLInputElement>("cast-audio").onchange = async (event) => {
  const control = event.target as HTMLInputElement;
  try {
    element("audio-status").textContent = control.checked ? "Loading samples…" : "Muted";
    await audio.setEnabled(control.checked);
    element("audio-status").textContent = control.checked ? "Sound ready" : "Muted";
  } catch (error) {
    control.checked = false;
    await audio.setEnabled(false);
    element("audio-status").textContent = `Sound unavailable: ${error}`;
  }
};
element<HTMLInputElement>("audio-volume").oninput = (event) =>
  audio.setVolume(Number((event.target as HTMLInputElement).value));
window.addEventListener("pagehide", () => audio.dispose());
if (new URLSearchParams(location.search).get("cast") === "1") {
  for (const id of ["native-operative", "native-cast"])
    element<HTMLInputElement>(id).checked = true;
  for (const id of ["player-overlays", "cast-overlays"])
    element<HTMLInputElement>(id).checked = false;
}
class CombatScene extends Phaser.Scene {
  private supplies?: PickupOverlay;
  private overlay?: Phaser.GameObjects.Graphics;
  private cast?: NativeCast;
  private hero?: NativeOperative;
  constructor() {
    super("combat-lab");
  }
  preload() {
    NativeCast.preload(this);
    NativeOperative.preload(this);
  }
  create() {
    this.supplies = new PickupOverlay(this);
    this.cast = new NativeCast(this);
    this.hero = new NativeOperative(this);
    nativeAtlas = this.hero.atlas;
    this.overlay = this.add.graphics().setDepth(2);
    inspect();
  }
  update(_time: number, delta: number) {
    if (running) {
      accumulator += delta * Number(element<HTMLSelectElement>("speed").value);
      if (delta > 250 || accumulator > 250) {
        pause();
        inspect("presentation stalled; recording paused");
      }
      let steps = 0;
      while (running && accumulator >= 1000 / 60 && steps++ < 4) {
        accumulator -= 1000 / 60;
        step();
      }
    }
    const g = this.overlay;
    if (!g) return;
    supplyMarkers =
      this.supplies?.draw(
        state.pickups.items,
        combatPickupDefinitions(state.scenario, state.players.length),
      ) ?? [];
    g.clear();
    const showCast = element<HTMLInputElement>("native-cast").checked,
      castOverlays = !showCast || element<HTMLInputElement>("cast-overlays").checked;
    castFrames = this.cast?.draw(state, castMotion, showCast) ?? [];
    nativeFrames =
      this.hero?.draw(state, motion, element<HTMLInputElement>("native-operative").checked) ?? [];
    for (const target of combatEndTerrain(state.scenario, state.tick, state.props)) {
      g.fillStyle(0x526175);
      g.fillRect(
        target.rect.x / 256,
        target.rect.y / 256,
        target.rect.w / 256,
        target.rect.h / 256,
      );
    }
    for (const player of state.players) {
      if (player.bodyPresence === "removed" || player.life === "spectating") continue;
      if (
        (nativeFrames[player.slot] ||
          (showCast &&
            (player.vehicleId !== null || ["enter", "exit"].includes(player.action.kind)))) &&
        !element<HTMLInputElement>("player-overlays").checked
      )
        continue;
      const contact = nativeFrames[player.slot]?.contact;
      if (contact) {
        g.lineStyle(1, 0xa4e488);
        g.lineBetween(contact.x - 3, contact.y, contact.x + 3, contact.y);
        g.lineBetween(contact.x, contact.y - 3, contact.x, contact.y + 3);
      }
      const shape = COMBAT_SHAPES.get(player.body.shapeId);
      if (!shape) continue;
      const rect = worldRect(player.body, shape.rect, player.facing);
      g.lineStyle(1, [0x72dfed, 0xbba4ff, 0xa4e488, 0xffcc88][player.slot] ?? 0xffffff);
      g.strokeRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
      const pose = ["fire", "melee", "grenade"].includes(player.action.kind)
        ? actionPose(
            COMBAT_CATALOG,
            player.action.definitionId,
            state.tick - player.action.stateStartTick,
          )
        : player.life === "alive" &&
            player.vehicleId === null &&
            player.weapon.id === "heavy-machine-gun"
          ? actionPose(COMBAT_CATALOG, firearmPoseTimeline(player, COMBAT_CATALOG), 0)
          : null;
      const handSocket = pose?.sockets.find((socket) => socket.name === "hand"),
        blade = COMBAT_SHAPES.get(9);
      if (player.action.kind === "melee" && handSocket && blade) {
        const hand = worldSocket(player.body, handSocket.point, player.facing),
          r = worldRect(hand, blade.rect, player.facing),
          active = state.strikes.some((strike) => strike.ownerId === player.body.id);
        g.lineStyle(1, active ? 0xffe475 : 0xffce60);
        g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
      }
      for (const id of pose?.hurtShapeIds ?? []) {
        const hurt = COMBAT_SHAPES.get(id);
        if (!hurt) continue;
        const r = worldRect(player.body, hurt.rect, player.facing);
        g.lineStyle(1, 0xff677d);
        g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
      }
      const muzzle = pose?.sockets.find((socket) => socket.name === "muzzle");
      if (muzzle) {
        const point = worldSocket(player.body, muzzle.point, player.facing);
        if (handSocket) {
          const hand = worldSocket(player.body, handSocket.point, player.facing);
          g.lineStyle(2, 0xff80db);
          g.lineBetween(hand.x / 256, hand.y / 256, point.x / 256, point.y / 256);
        }
        g.fillStyle(0xff80db);
        g.fillCircle(point.x / 256, point.y / 256, 2);
      }
    }
    if (castOverlays) for (const tank of state.tanks) drawTankOverlay(g, tank, state.tick);
    for (const hurt of combatHurtboxes(state.targets, state.tick)) {
      if (!castOverlays) break;
      g.lineStyle(1, hurt.kind === "shield" ? 0xffae43 : 0xff677d);
      g.strokeRect(hurt.rect.x / 256, hurt.rect.y / 256, hurt.rect.w / 256, hurt.rect.h / 256);
    }
    for (const target of state.targets) {
      if (!castOverlays) break;
      const guard = target.guard;
      if (guard && target.health > 0) {
        const age = state.tick - guard.action.stateStartTick;
        const presentation = shieldPresentation(shieldMode(guard), age, SHIELD_PROFILE);
        if (!presentation.raised) {
          const x = target.enemy.body.x / 256,
            y = target.enemy.body.y / 256 - 36;
          g.lineStyle(2, presentation.phase === "stunned" ? 0xbba4ff : 0xffce60);
          g.lineBetween(x - 7, y, x + 7, y);
          if (presentation.broken) g.lineBetween(x - 4, y - 3, x + 4, y + 3);
        }
        if (
          guard.phase === "bash" &&
          age < SHIELD_PROFILE.bashActiveTick + SHIELD_PROFILE.bashActiveTicks
        ) {
          const socket = actionPose(COMBAT_CATALOG, guard.action.definitionId, age)?.sockets.find(
            (socket) => socket.name === "hand",
          );
          const shape = COMBAT_SHAPES.get(12);
          if (socket && shape) {
            const r = worldRect(
              worldSocket(target.enemy.body, socket.point, guard.facing),
              shape.rect,
              guard.facing,
            );
            g.lineStyle(1, age < SHIELD_PROFILE.bashActiveTick ? 0xffce60 : 0xff677d);
            g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
          }
        }
      }
      const rifle = target.rifle;
      if (rifle?.action.kind !== "fire") continue;
      const mode = rifleMode(rifle, state.tick, RIFLE_PROFILE);
      const pose = actionPose(
        COMBAT_CATALOG,
        rifle.action.definitionId,
        state.tick - rifle.action.stateStartTick,
      );
      const socket = pose?.sockets.find((socket) => socket.name === "muzzle");
      if (!socket) continue;
      const muzzle = worldSocket(target.enemy.body, socket.point, target.enemy.facing);
      g.lineStyle(1, mode === 1 ? 0xffce60 : mode === 3 ? 0x9d91a9 : 0xff677d);
      g.strokeCircle(muzzle.x / 256, muzzle.y / 256, 3);
      if (mode !== 3)
        g.lineBetween(
          muzzle.x / 256,
          muzzle.y / 256,
          muzzle.x / 256 + (rifle.aim === 0 ? target.enemy.facing * 30 : 0),
          muzzle.y / 256 - (rifle.aim === 1 ? 30 : 0),
        );
    }
    for (const area of state.areas) {
      const profile = AREA_PROFILES.get(area.definitionId);
      if (!profile) continue;
      for (const exposure of areaExposures(
        area,
        state.tick,
        profile,
        combatTerrain(state.scenario, state.tick, state.props),
      )) {
        const r = exposure.rect,
          color = area.definitionId === 10 ? 0xffe475 : exposure.attached ? 0xff9647 : 0xff5b45;
        g.fillStyle(color, 0.3);
        g.fillRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
        g.lineStyle(1, color);
        g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
      }
    }
    for (const grenade of state.grenades) {
      g.fillStyle(0xa4e488);
      g.fillCircle(grenade.body.x / 256, grenade.body.y / 256, 3);
      if (state.tick - grenade.spawnTick >= GRENADE_PROFILE.fuseTicks - 15) {
        g.lineStyle(1, 0xff677d);
        g.strokeCircle(grenade.body.x / 256, grenade.body.y / 256, 5);
      }
    }
    for (const beam of state.beams) {
      for (const { rect } of beamExposures(beam, LASER_PROFILE)) {
        g.fillStyle(0x75f6ff, 0.65);
        g.fillRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
      }
    }
    for (const rocket of state.rockets) {
      const rect = worldRect(rocket.position, ROCKET_SHAPE.rect, 1);
      g.lineStyle(1, 0xffb56b);
      g.strokeRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
      g.lineBetween(
        rocket.position.x / 256,
        rocket.position.y / 256,
        (rocket.position.x - rocket.velocity.x * 3) / 256,
        (rocket.position.y - rocket.velocity.y * 3) / 256,
      );
    }
    for (const projectile of state.projectiles) {
      if (projectile.spawnTick === state.tick) {
        g.fillStyle(projectile.team === 2 ? 0xff677d : 0xffe475);
        g.fillRect(projectile.position.x / 256 - 1, projectile.position.y / 256 - 1, 2, 2);
        continue;
      }
      g.lineStyle(
        projectile.definitionId === 2 ? 2 : 1,
        projectile.team === 2 ? 0xff677d : 0xffe475,
      );
      g.lineBetween(
        projectile.position.x / 256,
        projectile.position.y / 256,
        (projectile.position.x - projectile.velocity.x) / 256,
        (projectile.position.y - projectile.velocity.y) / 256,
      );
    }
    for (const event of state.events)
      if (event.kind === "explosion") {
        g.lineStyle(1, 0xa4e488);
        g.strokeCircle(
          event.position.x / 256,
          event.position.y / 256,
          (event.source?.definitionId === ROCKET_ATTACK.id
            ? ROCKET_PROFILE.blastRadius
            : GRENADE_PROFILE.radius) / 256,
        );
      } else if (event.kind === "impact" || event.kind === "muzzle-blocked") {
        g.lineStyle(1, 0xffffff);
        g.strokeCircle(event.position.x / 256, event.position.y / 256, 3);
      }
  }
}
new Phaser.Game({
  type: Phaser.AUTO,
  parent: surface,
  width: 384,
  height: 216,
  backgroundColor: "#0b1018",
  pixelArt: true,
  zoom: 2,
  scene: [CombatScene],
  input: { keyboard: false },
  audio: { noAudio: true },
  banner: false,
});
Object.assign(globalThis, {
  combatLab: {
    state: () => structuredClone(state),
    recording,
    running: () => running,
    nativeFrames: () => structuredClone(nativeFrames),
    castFrames: () => structuredClone(castFrames),
    supplyMarkers: () => structuredClone(supplyMarkers),
    audio: () => audio.inspect(),
    startAudioCapture: () => audio.startCapture(),
    startVideoCapture: () => {
      const canvas = surface.querySelector("canvas");
      if (!canvas) throw new Error("Missing game canvas");
      audio.startCapture(canvas.captureStream(60));
    },
    stopAudioCapture: () => audio.stopCapture(),
  },
});
