import Phaser from "phaser";
import type { CombatLab } from "../game/labs/combat.js";
import {
  CAST_ART,
  type CastDrawing,
  type CastMotion,
  enemyPresentation,
  tankPresentation,
} from "../shared/animation/cast.js";
import type { NativeAtlas } from "../shared/animation/native.js";
import { drawTankIndicators } from "./tank-indicators.js";

/** Static atlas images only; this adapter cannot change a body, action, hit or seat. */
export class NativeCast {
  private readonly images: Phaser.GameObjects.Image[] = [];
  private readonly atlases: Map<string, NativeAtlas>;
  private readonly indicators: Phaser.GameObjects.Graphics;
  static preload(scene: Phaser.Scene): void {
    for (const asset of CAST_ART) {
      const path = `/assets/art/${asset.directory}/${asset.id}`;
      scene.load.atlas(asset.id, `${path}.png`, `${path}.atlas.json`);
      scene.load.json(`${asset.id}-metadata`, `${path}.atlas.json`);
    }
  }
  constructor(private readonly scene: Phaser.Scene) {
    this.indicators = scene.add.graphics().setDepth(2.5);
    this.atlases = new Map(
      CAST_ART.map((asset) => [
        asset.id,
        scene.cache.json.get(`${asset.id}-metadata`) as NativeAtlas,
      ]),
    );
  }
  draw(world: CombatLab, motion: CastMotion, enabled: boolean): CastDrawing[] {
    const frames: CastDrawing[] = [];
    this.indicators.clear();
    if (enabled) {
      for (const tank of world.tanks) {
        const owner = world.players.find(
          (player) => player.playerId === (tank.occupantId ?? tank.reservedBy),
        );
        const atlas = this.atlases.get("kestrel");
        if (!atlas) throw new Error("Missing tank atlas");
        const clock = motion.tanks.find((c) => c.id === tank.body.id);
        if (!clock) throw new Error("Missing tank motion");
        frames.push(...tankPresentation(tank, world.tick, atlas, clock, owner?.slot ?? 0));
        drawTankIndicators(this.indicators, tank, world.tick);
      }
      for (const target of world.targets) {
        const atlas = this.atlases.get(target.guard || target.shield ? "breakwater" : "quay-watch");
        if (!atlas) throw new Error("Missing enemy atlas");
        const clock = motion.enemies.find((c) => c.id === target.enemy.body.id);
        if (!clock) throw new Error("Missing enemy motion");
        const frame = enemyPresentation(target, world, atlas, clock.strideQ);
        if (frame) frames.push(frame);
      }
    }
    while (this.images.length < frames.length)
      this.images.push(
        this.scene.add.image(0, 0, "quay-watch", "base/watch-idle").setDepth(0.8).setVisible(false),
      );
    for (const [index, image] of this.images.entries()) {
      const frame = frames[index];
      image.setVisible(Boolean(frame));
      if (frame) {
        image
          .setTexture(frame.texture, frame.frame)
          .setOrigin(frame.originX, frame.originY)
          .setPosition(frame.x, frame.y)
          .setFlipX(frame.flipX)
          .clearTint()
          .setTintMode(frame.tintFill ? Phaser.TintModes.FILL : Phaser.TintModes.MULTIPLY);
        if (frame.tint !== undefined) {
          image.setTint(frame.tint);
        }
      }
    }
    return frames;
  }
}
