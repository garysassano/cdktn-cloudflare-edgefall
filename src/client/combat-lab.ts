import Phaser from "phaser";
import { actionPose } from "../game/combat/timeline.js";
import { canonical } from "../game/core/canonical.js";
import { Held } from "../game/input/types.js";
import {
  COMBAT_LAB_LIMIT,
  COMBAT_SCENARIOS,
  type CombatCommand,
  type CombatRecording,
  combatHurtboxes,
  combatTerrain,
  createCombatLab,
  replayCombatLab,
  stepCombatLab,
} from "../game/labs/combat.js";
import { COMBAT_CATALOG, COMBAT_SHAPES } from "../game/labs/combat-content.js";
import { worldRect, worldSocket } from "../game/physics/body.js";

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
  running = false,
  accumulator = 0,
  jump = false,
  fire = false;
const keys = new Set<string>();
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
    `Tick ${state.tick} · ${state.encounter.phase} · ${running ? "running" : "paused"}${message ? ` · ${message}` : ""}`;
}
function pause() {
  running = false;
  accumulator = 0;
  keys.clear();
  jump = fire = false;
  element("run").textContent = "Run";
}
function step() {
  if (state.tick >= COMBAT_LAB_LIMIT) {
    pause();
    inspect("recording limit");
    return;
  }
  const command = {
    held: [...keys].reduce((mask, key) => mask | (bindings[key] ?? 0), 0),
    jumpPressed: jump,
    firePressed: fire,
  };
  jump = fire = false;
  const inputs = state.players.map((_, slot) =>
    slot === 0
      ? command
      : {
          held: element<HTMLInputElement>("assist").checked ? Held.Fire : 0,
          jumpPressed: false,
          firePressed: false,
        },
  );
  try {
    state = stepCombatLab(state, inputs);
    commands.push(inputs);
    inspect();
  } catch (error) {
    pause();
    inspect(`stopped: ${error}`);
  }
}
function reset() {
  pause();
  commands = [];
  state = createCombatLab(
    COMBAT_SCENARIOS.find((scenario) => scenario === scenarios.value) ?? "range",
    Number(players.value),
  );
  inspect();
}
function recording(): CombatRecording {
  return {
    format: 1,
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
  if (!(event.code in bindings) && event.code !== "Space") return;
  event.preventDefault();
  if (event.repeat) return;
  if (!keys.has(event.code)) {
    if (event.code === "Space") jump = true;
    if (event.code === "KeyZ") fire = true;
  }
  keys.add(event.code);
});
surface.addEventListener("keyup", (event) => {
  if (event.code in bindings || event.code === "Space") event.preventDefault();
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
    element("run").textContent = "Pause";
    surface.focus();
  }
  inspect();
};
element("replay").onclick = () => {
  pause();
  try {
    state = replayCombatLab(recording());
    inspect("replay matches");
  } catch (error) {
    inspect(`replay failed: ${error}`);
  }
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
    const restored = replayCombatLab(imported);
    state = restored;
    commands = imported.commands;
    scenarios.value = state.scenario;
    players.value = String(state.players.length);
    inspect("imported replay matches");
  } catch (error) {
    inspect(`import rejected: ${error}`);
  }
};
class CombatScene extends Phaser.Scene {
  private overlay?: Phaser.GameObjects.Graphics;
  constructor() {
    super("combat-lab");
  }
  create() {
    this.overlay = this.add.graphics();
    inspect();
  }
  update(_time: number, delta: number) {
    if (running) {
      accumulator += delta;
      if (accumulator > 250) {
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
    g.clear();
    for (const target of combatTerrain(state.scenario)) {
      g.fillStyle(0x526175);
      g.fillRect(
        target.rect.x / 256,
        target.rect.y / 256,
        target.rect.w / 256,
        target.rect.h / 256,
      );
    }
    for (const player of state.players) {
      const shape = COMBAT_SHAPES.get(player.body.shapeId);
      if (!shape) continue;
      const rect = worldRect(player.body, shape.rect, player.facing);
      g.lineStyle(1, [0x72dfed, 0xbba4ff, 0xa4e488, 0xffcc88][player.slot] ?? 0xffffff);
      g.strokeRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
      const pose =
        player.action.kind === "fire"
          ? actionPose(
              COMBAT_CATALOG,
              player.action.definitionId,
              state.tick - player.action.stateStartTick,
            )
          : null;
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
        g.fillStyle(0xff80db);
        g.fillCircle(point.x / 256, point.y / 256, 2);
      }
    }
    for (const hurt of combatHurtboxes(state.targets)) {
      g.lineStyle(1, hurt.kind === "shield" ? 0xffae43 : 0xff677d);
      g.strokeRect(hurt.rect.x / 256, hurt.rect.y / 256, hurt.rect.w / 256, hurt.rect.h / 256);
    }
    for (const projectile of state.projectiles) {
      if (projectile.spawnTick === state.tick) {
        g.fillStyle(0xffe475);
        g.fillRect(projectile.position.x / 256 - 1, projectile.position.y / 256 - 1, 2, 2);
        continue;
      }
      g.lineStyle(projectile.definitionId === 2 ? 2 : 1, 0xffe475);
      g.lineBetween(
        projectile.position.x / 256,
        projectile.position.y / 256,
        (projectile.position.x - projectile.velocity.x) / 256,
        (projectile.position.y - projectile.velocity.y) / 256,
      );
    }
    for (const event of state.events)
      if (event.kind === "impact" || event.kind === "muzzle-blocked") {
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
  combatLab: { state: () => structuredClone(state), recording, running: () => running },
});
