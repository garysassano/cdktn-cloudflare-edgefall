import Phaser from "phaser";
import { areaExposures } from "../game/combat/area-attack.js";
import { canonical } from "../game/core/canonical.js";
import { Held } from "../game/input/types.js";
import { type CombatCommand, combatHurtboxes } from "../game/labs/combat.js";
import { AREA_PROFILES, COMBAT_SHAPES, GRENADE_PROFILE } from "../game/labs/combat-content.js";
import {
  type BreakwaterMission,
  type BreakwaterRecording,
  breakwaterTerrain,
  createBreakwater,
  replayBreakwater,
  stepBreakwater,
} from "../game/missions/breakwater.js";
import { lockEngineHurtboxes } from "../game/missions/breakwater-boss.js";
import { BREAKWATER } from "../game/missions/breakwater-content.js";
import { worldRect } from "../game/physics/body.js";
import {
  advanceBreakwaterVisual,
  breakwaterAudioCues,
  initialBreakwaterVisual,
} from "../shared/animation/breakwater.js";
import { advanceCastMotion, initialCastMotion } from "../shared/animation/cast.js";
import { operativeFootfalls } from "../shared/animation/combat-audio.js";
import { EFFECT_POSTROLL, effectDrawings } from "../shared/animation/combat-effects.js";
import {
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../shared/animation/operative-motion.js";
import { BreakwaterScenery } from "./breakwater-scenery.js";
import { CastAudio } from "./cast-audio.js";
import { NativeCast } from "./native-cast.js";
import { NativeEffects } from "./native-effects.js";
import { NativeOperative } from "./native-operative.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing mission control ${id}`);
  return value as T;
}
const surface = element("game"),
  audio = new CastAudio();
const settingsKey = "edgefall.benchmark.audio.v1";
try {
  const saved = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
  if (saved && typeof saved.sound === "boolean" && typeof saved.music === "boolean") {
    element<HTMLInputElement>("sound").checked = saved.sound;
    element<HTMLInputElement>("music").checked = saved.music;
    for (const [id, value] of [
      ["effects-volume", saved.effectsVolume],
      ["music-volume", saved.musicVolume],
    ] as const)
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
        element<HTMLInputElement>(id).value = String(value);
    if (saved.sound) element("audio-status").textContent = "Play to unlock audio";
  }
} catch {
  /* Storage can be unavailable or contain an obsolete preference. */
}
const saveAudioSettings = () => {
  try {
    localStorage.setItem(
      settingsKey,
      JSON.stringify({
        sound: element<HTMLInputElement>("sound").checked,
        music: element<HTMLInputElement>("music").checked,
        effectsVolume: Number(element<HTMLInputElement>("effects-volume").value),
        musicVolume: Number(element<HTMLInputElement>("music-volume").value),
      }),
    );
  } catch {
    /* Audio still works without persistent browser storage. */
  }
};
audio.setVolume(Number(element<HTMLInputElement>("effects-volume").value));
audio.setMusicVolume(Number(element<HTMLInputElement>("music-volume").value));
void audio.setMusicEnabled(element<HTMLInputElement>("music").checked);
let playRequest = 0;
let mission = createBreakwater(),
  running = false,
  accumulator = 0,
  commands: CombatCommand[][] = [],
  playback: CombatCommand[][] | null = null,
  castMotion = initialCastMotion(mission.combat),
  visual = initialBreakwaterVisual(),
  postroll = 0,
  heroMotion = mission.combat.players.map((p) => initialOperativeMotion(p, 0)),
  hero: NativeOperative | undefined,
  frames: {
    hero: ReturnType<NativeOperative["draw"]>;
    cast: ReturnType<NativeCast["draw"]>;
    boss: string;
    effects: ReturnType<typeof effectDrawings>;
  } = { hero: [], cast: [], boss: "engine-idle", effects: [] },
  cameraX = 0;
let lastFrameAt = performance.now();
const timing = { frames: 0, monotonicMs: 0, rendererMs: 0, maxFrameMs: 0 };
const held = new Set<string>(),
  padHeld = [0, 0, 0, 0],
  padEdges = [0, 0, 0, 0],
  padArmed = [false, false, false, false],
  padIds: Array<string | null> = [null, null, null, null],
  pending = Array.from({ length: 4 }, () => ({
    jumpPressed: false,
    firePressed: false,
    grenadePressed: false,
    interactPressed: false,
  }));
const bindings = [
  { KeyA: Held.Left, KeyD: Held.Right, KeyW: Held.Up, KeyS: Held.Down, KeyZ: Held.Fire },
  {
    ArrowLeft: Held.Left,
    ArrowRight: Held.Right,
    ArrowUp: Held.Up,
    ArrowDown: Held.Down,
    KeyN: Held.Fire,
  },
] as const;
const edges = [
  { Space: "jumpPressed", KeyZ: "firePressed", KeyC: "grenadePressed", KeyE: "interactPressed" },
  { Slash: "jumpPressed", KeyN: "firePressed", KeyM: "grenadePressed", Comma: "interactPressed" },
] as const;
function status(message = "") {
  element("status").textContent =
    `${mission.phase} · ${(mission.combat.tick / 60).toFixed(1)} s · ${mission.combat.players.map((p) => `P${p.slot + 1} ${p.lives} lives · ${p.weapon.id} ${p.weapon.id === "sidearm" ? "∞" : p.weapon.ammo}`).join(" | ")} · Lock engine ${mission.boss.health} · ${message}`;
  if (element<HTMLDetailsElement>("details").open)
    element("state").textContent = JSON.stringify(mission, null, 2);
}
function clearInput() {
  held.clear();
  padHeld.fill(0);
  padEdges.fill(0);
  padArmed.fill(false);
  for (const edge of pending)
    for (const key of Object.keys(edge)) edge[key as keyof typeof edge] = false;
}
function pause(hush = true) {
  playRequest++;
  running = false;
  accumulator = 0;
  clearInput();
  if (hush) audio.hush();
  element("run").textContent = "Play";
}
function startMission(players: number, seed: number) {
  const next = createBreakwater(players, seed);
  pause();
  audio.reset();
  playback = null;
  commands = [];
  mission = next;
  element<HTMLSelectElement>("players").value = String(players);
  element<HTMLInputElement>("seed").value = String(seed);
  castMotion = initialCastMotion(mission.combat);
  visual = initialBreakwaterVisual();
  postroll = 0;
  heroMotion = mission.combat.players.map((p) => initialOperativeMotion(p, 0));
  status();
}
function reset() {
  try {
    startMission(
      Number(element<HTMLSelectElement>("players").value),
      Number(element<HTMLInputElement>("seed").value),
    );
  } catch (error) {
    status(`New run rejected: ${error}`);
  }
}
function record(): BreakwaterRecording {
  return {
    format: 1,
    contentHash: mission.contentHash,
    seed: mission.seed,
    players: mission.combat.players.length,
    commands: structuredClone(commands),
    finalState: canonical(mission),
  };
}
function restore(recording: BreakwaterRecording) {
  let before: BreakwaterMission | undefined,
    restoredVisual = initialBreakwaterVisual(),
    cast = initialCastMotion(createBreakwater(recording.players, recording.seed).combat),
    clocks: typeof heroMotion = [];
  const restored = replayBreakwater(recording, (next) => {
    restoredVisual = before
      ? advanceBreakwaterVisual(restoredVisual, before, next)
      : initialBreakwaterVisual(next.combat.tick);
    cast = before
      ? advanceCastMotion(before.combat, next.combat, cast)
      : initialCastMotion(next.combat);
    clocks =
      before && hero
        ? next.combat.players.map((p, i) => {
            const old = before?.combat.players[i],
              clock = clocks[i];
            if (!old || !clock || !hero) throw new Error("Missing replay motion");
            return advanceOperativeMotion(old, p, clock, next.combat.tick, hero.atlas);
          })
        : next.combat.players.map((p) => initialOperativeMotion(p, next.combat.tick));
    before = next;
  });
  mission = restored;
  castMotion = cast;
  visual = restoredVisual;
  postroll = 0;
  heroMotion = clocks;
  commands = structuredClone(recording.commands);
  playback = null;
  audio.reset();
  element<HTMLSelectElement>("players").value = String(mission.combat.players.length);
  element<HTMLInputElement>("seed").value = String(mission.seed);
}
function step(submitted?: readonly CombatCommand[]) {
  if (!hero) return;
  if (mission.phase !== "playing") {
    if (postroll < EFFECT_POSTROLL) {
      postroll++;
      return;
    }
    pause(false);
    playback = null;
    status("Mission complete");
    return;
  }
  if (
    mission.combat.tick >= BREAKWATER.maxTicks ||
    (playback && mission.combat.tick === playback.length)
  ) {
    pause(false);
    playback = null;
    status(
      mission.combat.tick >= BREAKWATER.maxTicks
        ? "60 s recording limit reached"
        : "Playback complete or mission stopped",
    );
    return;
  }
  const inputs =
    (submitted ? structuredClone([...submitted]) : undefined) ??
    playback?.[mission.combat.tick] ??
    mission.combat.players
      .map((_, slot) => ({
        held: padHeld[slot] ?? 0,
        ...(pending[slot] ?? {
          jumpPressed: false,
          firePressed: false,
          grenadePressed: false,
          interactPressed: false,
        }),
      }))
      .map((input, slot) => ({
        ...input,
        held:
          input.held |
          [...held].reduce(
            (mask, key) =>
              mask | ((bindings[slot as 0 | 1] as Record<string, number> | undefined)?.[key] ?? 0),
            0,
          ),
      }));
  for (const edge of pending)
    for (const key of Object.keys(edge)) edge[key as keyof typeof edge] = false;
  try {
    const next = stepBreakwater(mission, inputs),
      atlas = hero.atlas;
    heroMotion = next.combat.players.map((p, i) => {
      const old = mission.combat.players[i],
        clock = heroMotion[i];
      if (!old || !clock) throw new Error("Missing mission motion");
      return advanceOperativeMotion(old, p, clock, next.combat.tick, atlas);
    });
    castMotion = advanceCastMotion(mission.combat, next.combat, castMotion);
    visual = advanceBreakwaterVisual(visual, mission, next);
    audio.setListenerX(cameraX + 192);
    audio.consume(
      next.combat,
      breakwaterAudioCues(mission, next, operativeFootfalls(heroMotion, atlas)),
      running,
    );
    mission = next;
    audio.setMusicPhase(mission.boss.phase !== "dormant");
    if (mission.phase !== "playing") audio.finish();
    commands.push(inputs);
    if (mission.combat.tick % 6 === 0 || !running) status();
  } catch (error) {
    pause();
    status(`Stopped: ${error}`);
  }
}
surface.addEventListener("keydown", (event) => {
  let used = false;
  for (let slot = 0; slot < 2; slot++) {
    if (
      event.code in (bindings[slot as 0 | 1] ?? {}) ||
      event.code in (edges[slot as 0 | 1] ?? {})
    ) {
      used = true;
      const edge = (edges[slot as 0 | 1] as Record<string, keyof (typeof pending)[0]>)[event.code],
        slotEdges = pending[slot];
      if (!event.repeat && !held.has(event.code) && edge && slotEdges) slotEdges[edge] = true;
    }
  }
  if (used) {
    event.preventDefault();
    held.add(event.code);
  }
});
surface.addEventListener("keyup", (event) => held.delete(event.code));
for (const target of [surface, window])
  target.addEventListener("blur", () => {
    pause();
    status("Paused");
  });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pause();
    status("Paused");
  }
});
for (const button of document.querySelectorAll("button"))
  button.addEventListener("pointerdown", (event) => event.preventDefault());
element("reset").onclick = reset;
element("step").onclick = () => {
  if (!running) step();
};
async function play() {
  const request = ++playRequest;
  await unlockAudio();
  if (request !== playRequest) return;
  running = true;
  audio.resume(mission.combat);
  audio.setMusicPhase(mission.boss.phase !== "dormant");
  audio.playMusic();
  element("run").textContent = "Pause";
  surface.focus();
}
element("run").onclick = async () => {
  if (running) pause();
  else await play();
  status();
};
element("check-recording").onclick = () => {
  pause();
  try {
    restore(record());
    status("Replay matches");
  } catch (error) {
    status(`Replay rejected: ${error}`);
  }
};
function preparePlayback(): boolean {
  const saved = structuredClone(commands);
  if (!saved.length) return false;
  startMission(mission.combat.players.length, mission.seed);
  playback = saved;
  return true;
}
element("play-recording").onclick = async () => {
  if (preparePlayback()) await play();
};
element("export").onclick = () => {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(record(), null, 2)], { type: "application/json" }),
    ),
    link = document.createElement("a");
  link.href = url;
  link.download = "breakwater-recording.json";
  link.click();
  URL.revokeObjectURL(url);
};
element<HTMLInputElement>("import").onchange = async (event) => {
  pause();
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || file.size > 4_000_000) throw new Error("Recording missing or too large");
    restore(JSON.parse(await file.text()));
    status("Imported replay matches");
  } catch (error) {
    status(`Import rejected: ${error}`);
  }
};
async function unlockAudio() {
  const control = element<HTMLInputElement>("sound");
  try {
    await audio.setEnabled(control.checked);
    audio.setMusicPhase(mission.boss.phase !== "dormant");
    if (running) audio.playMusic();
    element("audio-status").textContent = control.checked ? "Sound ready" : "Muted";
  } catch (error) {
    control.checked = false;
    await audio.setEnabled(false);
    element("audio-status").textContent = `Sound unavailable: ${error}`;
  }
}
element<HTMLInputElement>("sound").onchange = async () => {
  await unlockAudio();
  saveAudioSettings();
};
element<HTMLInputElement>("music").onchange = async () => {
  try {
    await audio.setMusicEnabled(element<HTMLInputElement>("music").checked);
  } catch (error) {
    element<HTMLInputElement>("music").checked = false;
    await audio.setMusicEnabled(false);
    element("audio-status").textContent = `Music unavailable: ${error}`;
  }
  saveAudioSettings();
};
for (const id of ["effects-volume", "music-volume"] as const)
  element<HTMLInputElement>(id).oninput = () => {
    const value = Number(element<HTMLInputElement>(id).value);
    if (id === "effects-volume") audio.setVolume(value);
    else audio.setMusicVolume(value);
    saveAudioSettings();
  };
window.addEventListener("pagehide", () => {
  pause();
  audio.dispose();
});

class BenchmarkScene extends Phaser.Scene {
  private scenery?: BreakwaterScenery;
  private cast?: NativeCast;
  private effects?: NativeEffects;
  private graphics?: Phaser.GameObjects.Graphics;
  constructor() {
    super("breakwater");
  }
  preload() {
    NativeOperative.preload(this);
    NativeCast.preload(this);
    BreakwaterScenery.preload(this);
    NativeEffects.preload(this);
  }
  create() {
    this.scenery = new BreakwaterScenery(this);
    this.cast = new NativeCast(this);
    this.effects = new NativeEffects(this);
    hero = new NativeOperative(this);
    this.graphics = this.add.graphics().setDepth(3);
    this.cameras.main.setBounds(0, 0, BREAKWATER.width, BREAKWATER.height);
    status();
  }
  update(_time: number, delta: number) {
    // Playback measures monotonic elapsed time directly; Phaser's presentation
    // delta remains diagnostic and cannot redefine an accepted 60 Hz boundary.
    const now = performance.now(),
      elapsed = Math.max(0, now - lastFrameAt);
    lastFrameAt = now;
    const pads = navigator.getGamepads();
    for (let slot = 0; slot < 4; slot++) {
      const candidate = pads[slot],
        pad = candidate?.connected && candidate.mapping === "standard" ? candidate : null,
        id = pad ? `${pad.index}:${pad.id}` : null;
      if (padIds[slot] !== id) {
        padArmed[slot] = false;
        padHeld[slot] = padEdges[slot] = 0;
        const edge = pending[slot];
        if (edge) for (const key of Object.keys(edge)) edge[key as keyof typeof edge] = false;
      }
      padIds[slot] = id;
      if (!pad) continue;
      const pressed = (i: number) => Boolean(pad.buttons[i]?.pressed),
        x = pad?.axes[0] ?? 0,
        y = pad?.axes[1] ?? 0;
      const intent =
        (x < -0.35 || pressed(14) ? Held.Left : 0) |
        (x > 0.35 || pressed(15) ? Held.Right : 0) |
        (y < -0.35 || pressed(12) ? Held.Up : 0) |
        (y > 0.35 || pressed(13) ? Held.Down : 0) |
        (pressed(2) ? Held.Fire : 0);
      const mask =
          (pressed(0) ? 1 : 0) | (pressed(2) ? 2 : 0) | (pressed(1) ? 4 : 0) | (pressed(3) ? 8 : 0),
        fresh = mask & ~(padEdges[slot] ?? 0),
        edge = pending[slot];
      if (document.activeElement !== surface || playback) padArmed[slot] = false;
      else if (mask === 0 && intent === 0) padArmed[slot] = true;
      padHeld[slot] = padArmed[slot] ? intent : 0;
      if (edge && padArmed[slot]) {
        edge.jumpPressed ||= Boolean(fresh & 1);
        edge.firePressed ||= Boolean(fresh & 2);
        edge.grenadePressed ||= Boolean(fresh & 4);
        edge.interactPressed ||= Boolean(fresh & 8);
      }
      padEdges[slot] = mask;
    }
    if (running) {
      timing.frames++;
      timing.monotonicMs += elapsed;
      timing.rendererMs += delta;
      timing.maxFrameMs = Math.max(timing.maxFrameMs, elapsed);
      accumulator += elapsed * Number(element<HTMLSelectElement>("speed").value);
      if (elapsed > 250 || accumulator > 250) {
        pause();
        status("Presentation stalled; recording paused");
      }
      let count = 0;
      while (running && accumulator >= 1000 / 60 && count++ < 4) {
        accumulator -= 1000 / 60;
        step();
      }
    }
    const alive = mission.combat.players.filter(
      (p) => p.life === "alive" || p.life === "respawning",
    );
    const lead = Math.max(48, ...alive.map((p) => p.body.x / 256));
    cameraX = Math.max(0, Math.min(BREAKWATER.width - 384, Math.round(lead - 144)));
    this.cameras.main.setScroll(cameraX, 0);
    const reduced = element<HTMLInputElement>("reduced-effects").checked;
    frames = {
      hero: hero?.draw(mission.combat, heroMotion) ?? [],
      cast: this.cast?.draw(mission.combat, castMotion, true) ?? [],
      boss: this.scenery?.draw(mission, visual.bossHitTick, reduced) ?? "engine-idle",
      effects: this.effects
        ? effectDrawings(
            visual.effects,
            mission.combat,
            this.effects.atlas,
            breakwaterTerrain(mission),
            mission.combat.tick + postroll,
            reduced,
            mission.phase !== "playing",
          )
        : [],
    };
    this.effects?.draw(frames.effects);
    const g = this.graphics;
    if (!g) return;
    g.clear();
    const debug = element<HTMLInputElement>("debug").checked;
    for (const player of mission.combat.players) {
      if (
        player.bodyPresence === "removed" ||
        player.life === "spectating" ||
        player.vehicleId !== null ||
        ["enter", "exit"].includes(player.action.kind)
      )
        continue;
      if (!debug && frames.hero[player.slot]) continue;
      const shape = COMBAT_SHAPES.get(player.body.shapeId);
      if (!shape) continue;
      const r = worldRect(player.body, shape.rect, player.facing);
      g.lineStyle(1, [0x72dfed, 0xbba4ff, 0xa4e488, 0xffcc88][player.slot] ?? 0xffffff);
      g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
    }
    if (!debug) return;
    if (debug) {
      for (const target of breakwaterTerrain(mission)) {
        g.lineStyle(1, 0xa4e488);
        g.strokeRect(
          target.rect.x / 256,
          target.rect.y / 256,
          target.rect.w / 256,
          target.rect.h / 256,
        );
      }
      for (const target of [
        ...combatHurtboxes(mission.combat.targets, mission.combat.tick),
        ...lockEngineHurtboxes(mission.boss),
      ]) {
        g.lineStyle(1, target.kind === "shield" ? 0xffae43 : 0xff677d);
        g.strokeRect(
          target.rect.x / 256,
          target.rect.y / 256,
          target.rect.w / 256,
          target.rect.h / 256,
        );
      }
    }
    for (const p of mission.combat.projectiles) {
      g.lineStyle(1, p.team === 2 ? 0xff677d : 0xffe475);
      g.lineBetween(
        p.position.x / 256,
        p.position.y / 256,
        (p.position.x - p.velocity.x) / 256,
        (p.position.y - p.velocity.y) / 256,
      );
    }
    for (const grenade of mission.combat.grenades) {
      g.fillStyle(0xa4e488);
      g.fillCircle(grenade.body.x / 256, grenade.body.y / 256, 3);
    }
    for (const area of mission.combat.areas) {
      const profile = AREA_PROFILES.get(area.definitionId);
      if (!profile) continue;
      for (const exposure of areaExposures(
        area,
        mission.combat.tick,
        profile,
        breakwaterTerrain(mission),
      )) {
        const r = exposure.rect;
        g.fillStyle(area.definitionId === 10 ? 0xffe475 : 0xff9647, 0.35);
        g.fillRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
      }
    }
    for (const event of mission.combat.events)
      if (["explosion", "impact", "muzzle-blocked"].includes(event.kind)) {
        g.lineStyle(1, 0xffe475);
        g.strokeCircle(
          event.position.x / 256,
          event.position.y / 256,
          event.kind === "explosion" ? GRENADE_PROFILE.radius / 256 : 3,
        );
      }
  }
}
new Phaser.Game({
  type: Phaser.AUTO,
  parent: surface,
  width: 384,
  height: 216,
  zoom: 2,
  pixelArt: true,
  roundPixels: true,
  scene: [BenchmarkScene],
  input: { keyboard: false },
  audio: { noAudio: true },
  banner: false,
});
Object.assign(globalThis, {
  breakwater: {
    state: () => structuredClone(mission),
    recording: record,
    frames: () => structuredClone(frames),
    visual: () => structuredClone(visual),
    presentationTick: () => mission.combat.tick + postroll,
    running: () => running,
    preparePlayback,
    cameraX: () => cameraX,
    audio: () => audio.inspect(),
    timing: () => ({ ...timing, wallMs: Date.now(), monotonicNow: performance.now() }),
    advance: (inputs: readonly CombatCommand[]) => {
      if (running) throw new Error("Pause before submitting an inspected boundary");
      step(inputs);
    },
    startCapture: () => {
      const canvas = surface.querySelector("canvas");
      if (!canvas) throw new Error("Missing mission canvas");
      audio.startCapture(canvas.captureStream(60));
    },
    stopCapture: () => audio.stopCapture(),
  },
});
