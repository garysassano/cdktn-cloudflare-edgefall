import type Phaser from "phaser";
import { TANK_PROFILE } from "../game/labs/combat-content.js";
import type { VehicleState } from "../game/state.js";
import { tankFeedback } from "../shared/animation/tank-feedback.js";

/** Player-facing status survives hidden collision overlays and reduced cosmetic effects. */
export function drawTankIndicators(
  g: Phaser.GameObjects.Graphics,
  tank: VehicleState,
  tick: number,
) {
  if (tank.armor === 0) return;
  const feedback = tankFeedback(tank, tick),
    x = Math.round(tank.body.x / 256),
    // Clear the highest authored muzzle (50 pixels above the body root).
    y = Math.round(tank.body.y / 256) - 26,
    color = feedback.critical ? 0xff785d : feedback.hitFlash ? 0xffffff : 0xa4e488;
  for (let pip = 0; pip < TANK_PROFILE.definition.armor; pip++) {
    g.fillStyle(pip < tank.armor ? color : 0x303946);
    g.fillRect(x - 8 + pip * 6, y - 32, 4, 3);
  }
  for (let shell = 0; shell < TANK_PROFILE.cannon.stock; shell++) {
    g.fillStyle(shell < tank.secondary.ammo ? 0xffcc88 : 0x303946);
    g.fillRect(x - 19 + shell * 4, y - 38, 2, 3);
  }
  if (feedback.critical) {
    // A persistent exclamation mark makes the warning readable without relying on color or flashes.
    g.fillStyle(0x18212c);
    g.fillRect(x - 29, y - 41, 7, 12);
    g.fillStyle(feedback.warningBright ? 0xffdb75 : 0xff785d);
    g.fillRect(x - 27, y - 39, 3, 5);
    g.fillRect(x - 27, y - 32, 3, 2);
  }
  if (tank.special.phase === "arming") {
    const progress = Math.min(
      1,
      (tick - tank.special.startTick + 1) / TANK_PROFILE.special.armTicks,
    );
    g.fillStyle(0x303946);
    g.fillRect(x - 22, y - 46, 44, 3);
    g.fillStyle(tick % 10 < 5 ? 0xff6655 : 0xffcc88);
    g.fillRect(x - 22, y - 46, 44 * progress, 3);
  }
}
