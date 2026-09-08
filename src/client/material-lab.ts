import Phaser from "phaser";
import { areaExposures } from "../game/combat/area-attack.js";
import { beamExposures } from "../game/combat/beam.js";
import { actionPose } from "../game/combat/timeline.js";
import {
  SURFACE_MATERIAL_IDS,
  type SurfaceMaterialId,
  surfaceMaterial,
} from "../game/content/materials.js";
import { LASER_PROFILE } from "../game/content/weapons/laser.js";
import {
  ROCKET_ATTACK,
  ROCKET_PROFILE,
  ROCKET_SHAPE,
} from "../game/content/weapons/rocket-launcher.js";
import { canonical, stateHash } from "../game/core/canonical.js";
import { Held } from "../game/input/types.js";
import type { CombatCommand } from "../game/labs/combat.js";
import {
  AREA_PROFILES,
  COMBAT_ATTACKS,
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  GRENADE_PROFILE,
} from "../game/labs/combat-content.js";
import {
  MATERIAL_LAB_WEAPONS,
  type MaterialLabDefinition,
  type MaterialRecording,
  createMaterialLab,
  createMaterialRecording,
  materialLabStage,
  replayMaterialLab,
  stepMaterialLab,
} from "../game/labs/materials.js";
import { worldRect, worldSocket } from "../game/physics/body.js";
import type { Rect } from "../game/state.js";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing material control ${id}`);
  return value as T;
}
const weapon = element<HTMLSelectElement>("weapon"),
  material = element<HTMLSelectElement>("material"),
  players = element<HTMLSelectElement>("players"),
  motion = element<HTMLSelectElement>("motion"),
  surface = element("game");
for (const value of MATERIAL_LAB_WEAPONS) weapon.add(new Option(value, value));
for (const value of SURFACE_MATERIAL_IDS) material.add(new Option(value, value));
material.value = "timber";
function selection(): MaterialLabDefinition {
  return {
    weapon: weapon.value as MaterialLabDefinition["weapon"],
    materialId: material.value as SurfaceMaterialId,
    players: Number(players.value),
    targetMotion: motion.value as MaterialLabDefinition["targetMotion"],
  };
}
let lab = createMaterialLab(selection()),
  commands: CombatCommand[][] = [],
  hashes = [stateHash(lab)],
  running = false,
  accumulator = 0,
  fire = false,
  grenade = false,
  jump = false,
  scene: MaterialScene | null = null,
  drawnTick = -1,
  presentedTick = -1,
  error = "";
let impacts: Array<{
  tick: number;
  x: number;
  y: number;
  targetId: number | null;
  damage: number;
}> = [];
const keys = new Set<string>();
const bindings: Record<string, number> = {
  ArrowLeft: Held.Left,
  ArrowRight: Held.Right,
  ArrowUp: Held.Up,
  ArrowDown: Held.Down,
  KeyZ: Held.Fire,
};
function pause(clearInput = true) {
  running = false;
  accumulator = 0;
  if (clearInput) {
    keys.clear();
    fire = grenade = jump = false;
  }
  element("run").textContent = "Run";
}
function inspect() {
  const world = lab.world;
  element("status").textContent =
    `Tick ${world.tick} · ${running ? "running" : "paused"} · cover ${world.props[0]?.health}/8 HP · targets ${world.targets.map((target) => target.health).join(" / ")} HP${error ? ` · ${error}` : ""}`;
  const policy = surfaceMaterial(lab.definition.materialId);
  element("policy").textContent = `${policy.id}: blocks ${Object.entries(policy.blocks)
    .filter(([, blocks]) => blocks)
    .map(([name]) => name)
    .join(", ")}. Damage scales: ${Object.entries(policy.damageScale)
    .map(([name, scale]) => `${name} ×${scale}`)
    .join(", ")}.`;
  element("details").textContent = JSON.stringify(
    {
      players: world.players.map((actor) => ({
        player: actor.playerId,
        weapon: actor.weapon.id,
        ammo: actor.weapon.ammo,
        grenades: actor.grenadeStock,
        shots: actor.weapon.shotOrdinal,
      })),
      recentRawImpacts: impacts.slice(-12),
    },
    null,
    2,
  );
}
function step() {
  if (lab.world.tick >= 3600) {
    pause();
    return;
  }
  let held = 0;
  for (const key of keys) held |= bindings[key] ?? 0;
  const input = lab.world.players.map(() => ({
    held,
    firePressed: fire,
    grenadePressed: grenade,
    jumpPressed: jump,
    specialPressed: false,
    interactPressed: false,
  }));
  try {
    lab = stepMaterialLab(lab, input);
    commands.push(input);
    hashes.push(stateHash(lab));
    impacts.push(
      ...lab.world.events
        .filter((event) => event.kind === "impact" && event.impact)
        .map((event) => ({
          tick: lab.world.tick,
          x: event.position.x,
          y: event.position.y,
          targetId: event.targetId,
          damage: event.impact?.damage ?? 0,
        })),
    );
    impacts = impacts.slice(-512);
    error = "";
  } catch (cause) {
    error = String(cause).slice(0, 300);
    pause();
  }
  fire = grenade = jump = false;
  scene?.draw();
  inspect();
}
function reset() {
  pause();
  lab = createMaterialLab(selection());
  commands = [];
  hashes = [stateHash(lab)];
  impacts = [];
  error = "";
  presentedTick = -1;
  scene?.draw();
  inspect();
}
class MaterialScene extends Phaser.Scene {
  private readonly boxes = new Map<string, Phaser.GameObjects.Rectangle>();
  private readonly blasts = new Map<number, Phaser.GameObjects.Arc>();
  create() {
    scene = this;
    this.draw();
  }
  update(_time: number, delta: number) {
    if (running) {
      accumulator = Math.min(100, accumulator + delta);
      while (accumulator >= 1000 / 60 && running) {
        accumulator -= 1000 / 60;
        step();
      }
    }
    this.draw();
  }
  draw() {
    const active = new Set<string>(),
      world = lab.world,
      stage = materialLabStage(lab);
    const box = (key: string, rect: Rect, color: number, alpha = 0.2) => {
      active.add(key);
      let item = this.boxes.get(key);
      if (!item) {
        item = this.add.rectangle(0, 0, 1, 1).setOrigin(0);
        this.boxes.set(key, item);
      }
      item
        .setPosition(rect.x / 256, rect.y / 256)
        .setSize(rect.w / 256, rect.h / 256)
        .setFillStyle(color, alpha)
        .setStrokeStyle(1, color)
        .setVisible(true);
    };
    const colors = {
      concrete: 0x88939e,
      timber: 0xd2a86d,
      "armor-steel": 0x729adb,
      "open-grating": 0x9bd18c,
    };
    for (const target of stage.terrain)
      box(
        `terrain:${target.id}`,
        target.rect,
        target.id === 100 ? 0x637386 : colors[lab.definition.materialId],
        0.65,
      );
    for (const actor of world.players) {
      const shape = COMBAT_SHAPES.get(actor.body.shapeId);
      if (shape && actor.bodyPresence === "present")
        box(`player:${actor.playerId}`, worldRect(actor.body, shape.rect, actor.facing), 0x66d9ef);
    }
    for (const target of world.targets) {
      const shape = COMBAT_SHAPES.get(target.enemy.body.shapeId);
      if (shape && target.health > 0)
        box(
          `target:${target.enemy.body.id}`,
          worldRect(target.enemy.body, shape.rect, target.enemy.facing),
          0xff7298,
        );
    }
    for (const projectile of world.projectiles) {
      const definition = COMBAT_ATTACKS.get(projectile.definitionId),
        shape = definition && COMBAT_SHAPES.get(definition.shapeId);
      if (shape)
        box(`bullet:${projectile.id}`, worldRect(projectile.position, shape.rect, 1), 0xfde480, 1);
    }
    for (const rocket of world.rockets)
      box(`rocket:${rocket.id}`, worldRect(rocket.position, ROCKET_SHAPE.rect, 1), 0xfde480, 1);
    for (const grenade of world.grenades) {
      const shape = COMBAT_SHAPES.get(grenade.body.shapeId);
      if (shape) box(`grenade:${grenade.id}`, worldRect(grenade.body, shape.rect, 1), 0x9ee49b, 1);
    }
    for (const area of world.areas) {
      const profile = AREA_PROFILES.get(area.definitionId);
      if (profile)
        for (const exposure of areaExposures(area, world.tick, profile, stage.terrain))
          box(
            `area:${area.id}:${exposure.lobe}`,
            exposure.rect,
            area.definitionId === 11 ? 0xff9944 : 0xfde480,
          );
    }
    for (const beam of world.beams)
      for (const [index, exposure] of beamExposures(beam, LASER_PROFILE).entries())
        box(`beam:${beam.id}:${index}`, exposure.rect, 0xb8fdff, 0.75);
    for (const strike of world.strikes) {
      const owner = world.players.find((actor) => actor.playerId === strike.ownerId),
        attack = COMBAT_ATTACKS.get(strike.definitionId),
        shape = attack && COMBAT_SHAPES.get(attack.shapeId);
      if (!owner || !shape) throw new Error("Missing inspector melee geometry");
      const pose = actionPose(
          COMBAT_CATALOG,
          owner.action.definitionId,
          world.tick - owner.action.stateStartTick,
        ),
        hand = pose?.sockets.find((socket) => socket.name === "hand");
      if (!hand) throw new Error("Missing inspector melee socket");
      box(
        `knife:${strike.id}`,
        worldRect(worldSocket(owner.body, hand.point, owner.facing), shape.rect, owner.facing),
        0xfde480,
      );
    }
    const explosions = world.events.filter((event) => event.kind === "explosion");
    for (const [index, event] of explosions.entries()) {
      let circle = this.blasts.get(index);
      if (!circle) {
        circle = this.add.circle(0, 0, 1, 0x9ee49b, 0.05).setStrokeStyle(1, 0x9ee49b);
        this.blasts.set(index, circle);
      }
      circle
        .setPosition(event.position.x / 256, event.position.y / 256)
        .setRadius(
          (event.source?.definitionId === ROCKET_ATTACK.id
            ? ROCKET_PROFILE.blastRadius
            : GRENADE_PROFILE.radius) / 256,
        );
    }
    for (const [id, circle] of this.blasts)
      if (id >= explosions.length) {
        circle.destroy();
        this.blasts.delete(id);
      }
    for (const [index, impact] of impacts.entries())
      if (world.tick - impact.tick <= 6)
        box(
          `impact:${index}`,
          { x: impact.x - 256, y: impact.y - 256, w: 512, h: 512 },
          0xff4d4d,
          1,
        );
    for (const [key, item] of this.boxes)
      if (!active.has(key)) {
        item.destroy();
        this.boxes.delete(key);
      }
    drawnTick = world.tick;
  }
  shapes() {
    return [...this.boxes].map(([key, item]) => ({
      key,
      x: item.x,
      y: item.y,
      w: item.width,
      h: item.height,
      visible: item.visible,
    }));
  }
  circles() {
    return [...this.blasts].map(([id, item]) => ({
      id,
      x: item.x,
      y: item.y,
      radius: item.radius,
      visible: item.visible,
    }));
  }
}
const game = new Phaser.Game({
  type: Phaser.CANVAS,
  parent: "game",
  width: 384,
  height: 216,
  pixelArt: true,
  backgroundColor: "#080e17",
  scene: MaterialScene,
  banner: false,
  audio: { noAudio: true },
  input: { keyboard: false },
});
game.events.on(Phaser.Core.Events.POST_RENDER, () => {
  presentedTick = drawnTick;
});
surface.addEventListener("keydown", (event) => {
  if (bindings[event.code] !== undefined || ["KeyC", "Space", "Enter"].includes(event.code))
    event.preventDefault();
  if (!event.repeat) {
    if (event.code === "KeyZ") fire = true;
    if (event.code === "KeyC") grenade = true;
    if (event.code === "Space") jump = true;
    keys.add(event.code);
  }
  if (event.code === "Enter" && !event.repeat && !running) step();
});
surface.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});
function blur() {
  pause();
  inspect();
}
window.addEventListener("blur", blur);
surface.addEventListener("blur", blur);
// Pointer controls retain the focused input surface and any accepted short tap.
for (const id of ["run", "step"]) element(id).onpointerdown = (event) => event.preventDefault();
for (const control of [weapon, material, players, motion]) control.onchange = reset;
element("reset").onclick = reset;
element("run").onclick = () => {
  if (running) pause();
  else {
    running = true;
    element("run").textContent = "Pause";
  }
  surface.focus();
  inspect();
};
element("step").onclick = () => {
  pause(false);
  step();
  surface.focus();
};
element("replay").onclick = () => {
  pause();
  try {
    replayMaterialLab(createMaterialRecording(lab, commands));
    error = "Replay matches";
  } catch (cause) {
    error = String(cause).slice(0, 300);
  }
  inspect();
};
element("export").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(createMaterialRecording(lab, commands))], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "edgefall-material-recording.json";
  link.click();
  URL.revokeObjectURL(url);
};
element<HTMLInputElement>("import").onchange = async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  pause();
  try {
    if (file.size > 2 ** 22) throw new Error("Material recording exceeds 4 MiB");
    const recording = JSON.parse(await file.text()) as MaterialRecording,
      restoredHashes: string[] = [];
    const restored = replayMaterialLab(recording, (state) => restoredHashes.push(stateHash(state)));
    lab = restored;
    commands = structuredClone(recording.commands);
    hashes = restoredHashes;
    impacts = [];
    error = "Imported replay matches";
    weapon.value = lab.definition.weapon;
    material.value = lab.definition.materialId;
    players.value = String(lab.definition.players);
    motion.value = lab.definition.targetMotion;
    presentedTick = -1;
    scene?.draw();
  } catch (cause) {
    error = String(cause).slice(0, 300);
  }
  inspect();
};
Object.assign(globalThis, {
  materialLab: {
    state: () => structuredClone(lab),
    recording: () => createMaterialRecording(lab, commands),
    status: () => ({
      ready: scene !== null,
      presentedTick,
      definition: { ...lab.definition },
      tick: lab.world.tick,
      hash: stateHash(lab),
      hashes: [...hashes],
      shapes: scene?.shapes() ?? [],
      circles: scene?.circles() ?? [],
      error,
    }),
    advance: (ticks: number) => {
      if (!Number.isInteger(ticks) || ticks < 1 || ticks > 30)
        throw new Error("Invalid inspector advance");
      for (let index = 0; index < ticks; index++) step();
    },
    canonical: () => canonical(lab),
  },
});
inspect();
