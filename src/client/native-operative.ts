import type Phaser from "phaser";
import type { CombatLab } from "../game/labs/combat.js";
import type { NativeAtlas } from "../shared/animation/native.js";
import { operativePresentation } from "../shared/animation/operative.js";
import type { OperativeMotion } from "../shared/animation/operative-motion.js";

/** Shared atlas adapter for the combat inspector and continuous mission specimen. */
export class NativeOperative {
  readonly atlas: NativeAtlas;
  private readonly images: Array<Record<"legs" | "upper" | "fullBody", Phaser.GameObjects.Image>> =
    [];
  static preload(scene: Phaser.Scene): void {
    scene.load.atlas(
      "operative",
      "/assets/art/hero/operative.png",
      "/assets/art/hero/operative.atlas.json",
    );
    scene.load.json("operative-metadata", "/assets/art/hero/operative.atlas.json");
  }
  constructor(scene: Phaser.Scene) {
    this.atlas = scene.cache.json.get("operative-metadata") as NativeAtlas;
    for (let slot = 0; slot < 4; slot++)
      this.images.push({
        legs: scene.add
          .image(0, 0, "operative", `p${slot + 1}/legs-idle`)
          .setDepth(1)
          .setVisible(false),
        upper: scene.add
          .image(0, 0, "operative", `p${slot + 1}/upper-horizontal`)
          .setDepth(1)
          .setVisible(false),
        fullBody: scene.add
          .image(0, 0, "operative", `p${slot + 1}/body-death-hit`)
          .setDepth(1)
          .setVisible(false),
      });
  }
  draw(world: CombatLab, motion: OperativeMotion[], enabled = true) {
    const frames = world.players.map((player, slot) =>
      enabled && motion[slot]
        ? operativePresentation(player, world.tick, this.atlas, motion[slot])
        : null,
    );
    for (const [slot, layers] of this.images.entries()) {
      const drawing = frames[slot];
      for (const [channel, image] of Object.entries(layers)) {
        const frame =
          drawing &&
          (channel === "legs"
            ? drawing.legsFrame
            : channel === "upper"
              ? drawing.upperFrame
              : drawing.fullBodyFrame);
        image.setVisible(Boolean(frame));
        if (drawing && frame)
          image
            .setFrame(frame)
            .setOrigin(drawing.originX, drawing.originY)
            .setFlipX(drawing.flipX)
            .setPosition(drawing.x, drawing.y)
            .setScale(1);
      }
    }
    return frames;
  }
}
