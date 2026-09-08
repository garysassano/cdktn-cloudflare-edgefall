import type Phaser from "phaser";
import type { WeaponPickupDefinition, WeaponPickupState } from "../game/combat/pickups.js";

/** Explicit engineering presentation; final pickup art follows the existing media review gate. */
export class PickupOverlay {
  private readonly markers = new Map<
    number,
    { body: Phaser.GameObjects.Rectangle; text: Phaser.GameObjects.Text; remaining: number }
  >();
  constructor(private readonly scene: Phaser.Scene) {}
  draw(items: WeaponPickupState["items"], definitions: readonly WeaponPickupDefinition[]) {
    const activeSources = new Set(definitions.map((def) => def.sourceId));
    for (const [sourceId, marker] of this.markers) {
      if (activeSources.has(sourceId)) continue;
      marker.body.destroy();
      marker.text.destroy();
      this.markers.delete(sourceId);
    }
    const labels = {
      sidearm: "S",
      "heavy-machine-gun": "H",
      shotgun: "SG",
      flamethrower: "F",
      "rocket-launcher": "R",
      laser: "L",
    };
    for (const sourceId of activeSources) {
      const supplies = definitions.filter((def) => def.sourceId === sourceId),
        def = supplies[0];
      if (!def) throw new Error("Missing supply marker definition");
      let marker = this.markers.get(sourceId);
      if (!marker) {
        marker = {
          body: this.scene.add
            .rectangle(
              def.rect.x / 256,
              def.rect.y / 256,
              def.rect.w / 256,
              def.rect.h / 256,
              0xb0e67d,
              0.25,
            )
            .setOrigin(0)
            .setStrokeStyle(1, 0xb0e67d)
            .setDepth(1),
          text: this.scene.add
            .text(def.rect.x / 256, def.rect.y / 256 - 10, "", {
              fontFamily: "monospace",
              fontSize: "8px",
              color: "#d7ffb4",
            })
            .setDepth(3),
          remaining: 0,
        };
        this.markers.set(sourceId, marker);
      }
      marker.remaining = supplies.filter((def) =>
        items.some((item) => item.id === def.id && item.status === "available"),
      ).length;
      marker.body.setVisible(marker.remaining > 0);
      marker.text
        .setText(`${labels[def.weaponId]}×${marker.remaining}`)
        .setVisible(marker.remaining > 0);
    }
    return [...this.markers].map(([sourceId, marker]) => ({
      sourceId,
      remaining: marker.remaining,
      visible: marker.body.visible,
      textVisible: marker.text.visible,
      text: marker.text.text,
    }));
  }
}
