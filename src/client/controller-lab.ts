import Phaser from "phaser";
import { Held } from "../game/input/types.js";
import {
  LAB_SCENARIOS,
  type LabCommand,
  type LabRecording,
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../game/labs/controller.js";
import { FOOT_SHAPES } from "../game/labs/foot-fixture.js";
import { worldRect } from "../game/physics/body.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing lab control ${id}`);
  return value as T;
}
const surface = element("game");
const select = element<HTMLSelectElement>("scenario");
for (const scenario of LAB_SCENARIOS) select.add(new Option(scenario, scenario));
let state = createControllerLab("course");
let commands: LabCommand[] = [];
let running = false;
let accumulator = 0;
let jump = false;
let remove = false;
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
};
function pause(): void {
  running = false;
  accumulator = 0;
  keys.clear();
  jump = false;
  element("run").textContent = "Run";
}
function inspect(): void {
  element("state").textContent = JSON.stringify(state, null, 2);
  element("status").textContent =
    `Tick ${state.tick} · revision ${state.geometryRevision} · ${state.stopped ?? (running ? "running" : "paused")} · ${commands.length} recorded inputs`;
}
function step(): void {
  if (state.stopped) return;
  const command = {
    held: [...keys].reduce((held, key) => held | (bindings[key] ?? 0), 0),
    jumpPressed: jump,
    removePlatform: remove,
  };
  jump = false;
  remove = false;
  state = stepControllerLab(state, command);
  commands.push(command);
  if (state.stopped) pause();
  inspect();
}
function recording(): LabRecording {
  return { format: 2, scenario: state.scenario, commands, finalState: labFingerprint(state) };
}
function reset(): void {
  pause();
  remove = false;
  commands = [];
  state = createControllerLab(LAB_SCENARIOS.find((s) => s === select.value) ?? "course");
  inspect();
}
for (const button of document.querySelectorAll("button")) {
  button.addEventListener("pointerdown", (event) => event.preventDefault());
}
surface.addEventListener("keydown", (event) => {
  if (event.code === "Enter") {
    event.preventDefault();
    if (!event.repeat && !running) step();
    return;
  }
  if (!(event.code in bindings) && event.code !== "Space") return;
  event.preventDefault();
  if (event.code === "Space" && !keys.has(event.code) && !event.repeat) jump = true;
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
element("run").onclick = () => {
  if (running) pause();
  else {
    running = true;
    accumulator = 0;
    element("run").textContent = "Pause";
    surface.focus();
  }
  inspect();
};
element("step").onclick = () => {
  step();
};
element("reset").onclick = reset;
select.onchange = reset;
element("remove").onclick = () => {
  remove = true;
  element("status").textContent = "Platform removal queued for next tick";
};
element("replay").onclick = () => {
  pause();
  state = replayControllerLab(recording());
  inspect();
  element("status").textContent += " · replay matches";
};
element("export").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(recording(), null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `edgefall-controller-${state.scenario}-${state.tick}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
element<HTMLInputElement>("import").onchange = async (event) => {
  pause();
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error("Recording exceeds 1 MiB");
    const imported: LabRecording = JSON.parse(await file.text());
    const restored = replayControllerLab(imported);
    state = restored;
    commands = imported.commands;
    remove = false;
    select.value = state.scenario;
    inspect();
    element("status").textContent += " · imported replay matches";
  } catch (error) {
    inspect();
    element("status").textContent +=
      ` · import rejected: ${error instanceof Error ? error.message : "invalid recording"}`;
  } finally {
    input.value = "";
  }
};
class ControllerLabScene extends Phaser.Scene {
  private overlay?: Phaser.GameObjects.Graphics;
  create(): void {
    this.overlay = this.add.graphics();
    inspect();
  }
  update(_time: number, delta: number): void {
    if (running) {
      accumulator += Math.min(delta, 100);
      let steps = 0;
      while (accumulator >= 1000 / 60 && running && steps++ < 6) {
        accumulator -= 1000 / 60;
        step();
      }
    }
    const graphics = this.overlay;
    if (!graphics) return;
    graphics.clear();
    for (const target of state.terrain) {
      const rect = target.rect;
      graphics.fillStyle(
        target.id === state.actor.body.supportId
          ? 0x4caa76
          : target.kind === "one-way"
            ? 0x647dc4
            : 0x445368,
      );
      graphics.fillRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
    }
    if (state.enemy && state.enemy.life === "alive") {
      const enemy = state.enemy;
      const shape = FOOT_SHAPES.get(enemy.body.shapeId);
      if (shape) {
        const rect = worldRect(enemy.body, shape.rect, enemy.facing);
        graphics.lineStyle(2, 0xff9876);
        graphics.strokeRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
        graphics.lineBetween(
          enemy.body.x / 256,
          enemy.body.y / 256 - 12,
          enemy.body.x / 256 + enemy.facing * 12,
          enemy.body.y / 256 - 12,
        );
      }
    }
    const body = state.actor.body;
    const shape = FOOT_SHAPES.get(body.shapeId);
    if (!shape) throw new Error("Missing rendered shape");
    const rect = worldRect(body, shape.rect, state.actor.facing);
    graphics.lineStyle(2, 0x72dfed);
    graphics.strokeRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
    const x = body.x / 256,
      y = body.y / 256;
    graphics.lineStyle(2, 0xffcd66);
    graphics.lineBetween(x - 4, y, x + 4, y);
    graphics.lineBetween(x, y - 4, x, y + 4);
    graphics.lineBetween(x, y - 12, x + state.actor.facing * 12, y - 12);
    graphics.lineStyle(2, 0xf787d7);
    for (const contact of body.contacts)
      graphics.lineBetween(x, y - 16, x + contact.normalX * 20, y - 16 + contact.normalY * 20);
  }
}
new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 640,
  height: 360,
  backgroundColor: "#1a2638",
  pixelArt: true,
  antialias: false,
  scene: ControllerLabScene,
  audio: { noAudio: true },
});
