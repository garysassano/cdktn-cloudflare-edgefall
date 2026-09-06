import Phaser from "phaser";
import {
  BASELINE_SCENARIOS,
  type BaselineScenario,
  advanceBaseline,
  createBaselineScenario,
} from "../game/labs/baseline.js";
import { createCompactSnapshot } from "../game/simulation.js";
import { EdgefallScene } from "./scene.js";

const requested = new URL(location.href).searchParams.get("scenario");
const scenario: BaselineScenario =
  BASELINE_SCENARIOS.find((id) => id === requested) ?? "enemy-ledge";
let state = createBaselineScenario(scenario);
let running = false;
class BaselineScene extends EdgefallScene {
  private diagnostics?: Phaser.GameObjects.Graphics;
  override create(): void {
    super.create();
    // Scripted fixtures must not receive the normal scene's keyboard prediction timer.
    this.time.removeAllEvents();
    this.diagnostics = this.add.graphics().setDepth(100);
    render();
  }

  override update(time: number, delta: number): void {
    super.update(time, delta);
    const graphics = this.diagnostics;
    if (!graphics) return;
    graphics.clear();
    if (!document.querySelector<HTMLInputElement>("#overlay")?.checked) return;
    graphics.lineStyle(1, 0x00ffff, 1);
    for (const shape of [...state.platforms, ...state.destructibles]) {
      graphics.strokeRect(shape.x, shape.y, shape.w, shape.h);
    }
    for (const player of Object.values(state.players)) {
      graphics.strokeRect(player.x - 10, player.y - 42, 20, 42);
    }
    graphics.lineStyle(1, 0xff00ff, 1);
    for (const enemy of state.enemies) graphics.strokeCircle(enemy.x, enemy.y, enemy.radius);
    for (const shot of state.projectiles) graphics.strokeCircle(shot.x, shot.y, shot.radius);
  }
}
const scene = new BaselineScene();
scene.setPresentationSettings({
  volume: 0,
  shake: false,
  flashes: false,
  contrast: false,
  reduceMotion: true,
});
new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 640,
  height: 360,
  pixelArt: true,
  antialias: false,
  scene,
  audio: { noAudio: true },
});
const output = document.querySelector("pre");
const select = document.querySelector("select");
if (!output || !select) throw new Error("Missing lab controls");
for (const id of BASELINE_SCENARIOS) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = id;
  option.selected = id === scenario;
  select.append(option);
}
select.addEventListener("change", () => {
  location.search = `?scenario=${select.value}`;
});
function render(): void {
  scene.applySnapshot(createCompactSnapshot(state), "p0", []);
  if (output)
    output.textContent = JSON.stringify(
      {
        scenario,
        seed: state.seed,
        protocol: 2,
        hz: 30,
        tick: state.tick,
        player: state.players.p0,
        enemies: state.enemies,
        projectiles: state.projectiles,
        terrain: state.platforms,
        objects: state.destructibles,
        events: state.events,
      },
      null,
      2,
    );
}
function step(): void {
  advanceBaseline(state, scenario);
  render();
}
document.querySelector("#step")?.addEventListener("click", step);
document.querySelector("#run")?.addEventListener("click", () => {
  running = !running;
});
document.querySelector("#reset")?.addEventListener("click", () => {
  running = false;
  state = createBaselineScenario(scenario);
  render();
});
window.setInterval(() => {
  if (running && state.tick < 300) step();
}, 1000 / 30);
render();
