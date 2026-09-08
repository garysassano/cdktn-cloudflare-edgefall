import type Phaser from "phaser";
import type { EffectDrawing } from "../shared/animation/combat-effects.js";
import type { NativeAtlas } from "../shared/animation/native.js";

/** Reused native images; every item has a finite accepted-tick lifetime or a live entity owner. */
export class NativeEffects {
  readonly atlas: NativeAtlas;
  private readonly sprites: Phaser.GameObjects.Image[] = [];
  static preload(scene: Phaser.Scene): void {
    scene.load.atlas(
      "breakwater-fx",
      "/assets/art/effects/breakwater-fx.png",
      "/assets/art/effects/breakwater-fx.atlas.json",
    );
    scene.load.json("breakwater-fx-metadata", "/assets/art/effects/breakwater-fx.atlas.json");
  }
  constructor(private readonly scene: Phaser.Scene) {
    this.atlas = scene.cache.json.get("breakwater-fx-metadata") as NativeAtlas;
  }
  draw(drawings: readonly EffectDrawing[]): void {
    if (drawings.length > 512) throw new Error("Native effect draw budget exhausted");
    for (const [index, drawing] of drawings.entries()) {
      let sprite = this.sprites[index];
      if (!sprite) {
        sprite = this.scene.add.image(0, 0, "breakwater-fx", drawing.frame).setOrigin(0.5);
        this.sprites.push(sprite);
      }
      sprite
        .setFrame(drawing.frame)
        .setPosition(drawing.x, drawing.y)
        .setFlip(drawing.flipX, drawing.flipY)
        .setAngle(drawing.turn)
        .setDepth(drawing.depth)
        .setAlpha(drawing.alpha)
        .setVisible(true);
      if (drawing.crop)
        sprite.setCrop(drawing.crop.x, drawing.crop.y, drawing.crop.w, drawing.crop.h);
      else sprite.setCrop();
    }
    for (let i = drawings.length; i < this.sprites.length; i++) this.sprites[i]?.setVisible(false);
  }
  inspect() {
    return {
      allocated: this.sprites.length,
      visible: this.sprites.filter((sprite) => sprite.visible).length,
    };
  }
}
