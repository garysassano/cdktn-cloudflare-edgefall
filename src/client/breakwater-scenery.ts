import type Phaser from "phaser";
import type { BreakwaterMission } from "../game/missions/breakwater.js";
import {
  BREAKWATER,
  BREAKWATER_PROPS,
  BREAKWATER_TERRAIN,
  breakwaterPickups,
} from "../game/missions/breakwater-content.js";
import { BREAKWATER_ART } from "../shared/animation/breakwater.js";

/** Native atlas tiles in fixed layers; terrain and damage remain mission-owned. */
export class BreakwaterScenery {
  private readonly caches = new Map<number, Phaser.GameObjects.Image>();
  private readonly supplyCounts = new Map<number, Phaser.GameObjects.Text>();
  private readonly supplySources = new Map(
    breakwaterPickups(4).map((item) => [item.id, item.sourceId]),
  );
  private readonly props = new Map<number, Phaser.GameObjects.Image>();
  private readonly boss: Phaser.GameObjects.Image;
  supplyIndicators() {
    return [...this.caches].map(([sourceId, sprite]) => ({
      sourceId,
      visible: sprite.visible,
      countText: this.supplyCounts.get(sourceId)?.text ?? "",
      countVisible: this.supplyCounts.get(sourceId)?.visible ?? false,
    }));
  }
  static preload(scene: Phaser.Scene): void {
    for (const asset of BREAKWATER_ART)
      scene.load.atlas(
        asset.id,
        `/assets/art/${asset.directory}/${asset.id}.png`,
        `/assets/art/${asset.directory}/${asset.id}.atlas.json`,
      );
  }
  constructor(scene: Phaser.Scene) {
    const image = (frame: string, x: number, y: number, depth: number, scroll = 1) =>
      scene.add
        .image(x, y, "breakwater-quay", `base/${frame}`)
        .setOrigin(0)
        .setDepth(depth)
        .setScrollFactor(scroll);
    for (let x = 0; x < 512; x += 128) {
      image("sky-top", x, 0, -5, 0);
      image("sky-bottom", x, 128, -5, 0);
    }
    for (let x = -128; x < 1280; x += 256) {
      image("cloud-bank", x, 0, -4, 0.08);
      image("harbor-crane", x + 70, 24, -3.5, 0.18);
      image("far-warehouse", x, 68, -3, 0.18);
    }
    for (let x = -128; x < 1536; x += 128) image("sea", x, 160, -2.5, 0.25);
    for (let x = -128; x < BREAKWATER.width; x += 384) {
      image("warehouse", x + 32, 72, -2, 0.55);
      image("harbor-crane", x + 218, 18, -2, 0.55);
    }
    for (let x = 0; x < BREAKWATER.width; x += 128) image("quay-wall", x, BREAKWATER.floor, 0.6);
    for (const surface of BREAKWATER_TERRAIN) {
      if (surface.kind === "one-way")
        image("catwalk", surface.rect.x / 256, surface.rect.y / 256 - 31, 0.55).setCrop(
          0,
          0,
          surface.rect.w / 256,
          128,
        );
      else if (surface.id === 103)
        image("quay-step", surface.rect.x / 256, surface.rect.y / 256, 0.6);
    }
    for (const x of [160, 448, 928, 1440, 1856, 2432, 2992]) image("lamp", x, 80, 0.4);
    for (const x of [100, 380, 650, 1100, 1590, 2170, 2730]) image("bollard", x, 183, 0.65);
    const names = {
      sidearm: "sidearm",
      "heavy-machine-gun": "hmg",
      shotgun: "shotgun",
      flamethrower: "flame",
    };
    for (const cache of BREAKWATER.pickups) {
      this.caches.set(
        cache.id,
        image(`cache-${names[cache.weapon]}`, cache.x - 16, cache.y - 23, 0.7),
      );
      this.supplyCounts.set(
        cache.id,
        scene.add
          .text(cache.x + 8, cache.y - 30, "", {
            fontFamily: "monospace",
            fontSize: "8px",
            color: "#fff0c1",
            backgroundColor: "#102d3b",
          })
          .setDepth(0.8),
      );
    }
    for (const prop of BREAKWATER_PROPS)
      this.props.set(prop.id, image("crate", prop.rect.x / 256, prop.rect.y / 256, 0.75));
    this.boss = scene.add
      .image(BREAKWATER.boss.x, BREAKWATER.boss.y, "lock-engine", "base/engine-idle")
      .setOrigin(64 / 128, 112 / 128)
      .setDepth(0.7);
  }
  draw(mission: BreakwaterMission, hitTick: number | null = null, reduced = false): string {
    const available = new Map<number, number>();
    for (const pickup of mission.supplies.items) {
      const sourceId = this.supplySources.get(pickup.id);
      if (sourceId !== undefined && pickup.status === "available")
        available.set(sourceId, (available.get(sourceId) ?? 0) + 1);
    }
    for (const [sourceId, sprite] of this.caches) {
      const count = available.get(sourceId) ?? 0;
      sprite.setVisible(count > 0);
      this.supplyCounts
        .get(sourceId)
        ?.setText(`×${count}`)
        .setVisible(count > 1);
    }
    for (const prop of mission.combat.props) this.props.get(prop.id)?.setVisible(prop.health > 0);
    const boss = mission.boss,
      age = mission.combat.tick - boss.phaseStartTick;
    const frame =
      boss.phase === "destroyed"
        ? "engine-wreck"
        : boss.phase === "recovery"
          ? !reduced && hitTick !== null && mission.combat.tick - hitTick < 6
            ? "engine-hit"
            : "engine-open"
          : boss.phase === "burst"
            ? age % 15 >= 1 && age % 15 <= 3
              ? "engine-recoil"
              : "engine-fire"
            : boss.phase === "windup" && (reduced || Math.floor(age / 5) % 2)
              ? "engine-windup"
              : "engine-idle";
    this.boss.setFrame(`base/${frame}`);
    return frame;
  }
}
