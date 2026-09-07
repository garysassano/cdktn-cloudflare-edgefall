import type Phaser from "phaser";
import { COMBAT_SHAPES, TANK_PROFILE } from "../game/labs/combat-content.js";
import { worldRect, worldSocket } from "../game/physics/body.js";
import type { VehicleState } from "../game/state.js";

/** Engineering collision/ownership inspection; these shapes are not final game media. */
export function drawTankOverlay(g: Phaser.GameObjects.Graphics, tank: VehicleState, tick: number) {
  const shape = COMBAT_SHAPES.get(tank.body.shapeId),
    heading = TANK_PROFILE.headings[tank.heading];
  if (!shape || !heading) return;
  const r = worldRect(tank.body, shape.rect, tank.facing),
    owner = tank.occupantId ?? tank.reservedBy;
  const color =
    tank.lifecycle === "wreck"
      ? 0x667080
      : tank.invulnerableTicks
        ? 0xffcc88
        : owner === null
          ? 0xa4e488
          : ([0x72dfed, 0xbba4ff, 0xa4e488, 0xffcc88][owner - 1] ?? 0xffffff);
  g.fillStyle(color, 0.15);
  g.fillRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
  g.lineStyle(1, color);
  g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
  const root = worldSocket(tank.body, TANK_PROFILE.hardpoint, 1),
    muzzle = worldSocket(tank.body, heading.muzzle, 1);
  g.lineStyle(2, color);
  if (tank.lifecycle !== "wreck") {
    g.lineBetween(root.x / 256, root.y / 256, muzzle.x / 256, muzzle.y / 256);
    g.strokeCircle(muzzle.x / 256, muzzle.y / 256, 2);
  }
  g.lineBetween(
    tank.body.x / 256,
    tank.body.y / 256 - 5,
    tank.body.x / 256 + tank.facing * 12,
    tank.body.y / 256 - 5,
  );
  for (let pip = 0; pip < TANK_PROFILE.definition.armor; pip++) {
    g.fillStyle(pip < tank.armor ? color : 0x303946);
    g.fillRect(tank.body.x / 256 - 8 + pip * 6, tank.body.y / 256 - 32, 4, 3);
  }
  if (tank.lifecycle === "boarding" || tank.lifecycle === "exiting") {
    const duration = tank.lifecycle === "boarding" ? 12 : 8;
    g.lineStyle(2, 0xffe475);
    g.lineBetween(
      r.x / 256,
      tank.body.y / 256 + 3,
      r.x / 256 + (r.w / 256) * Math.min(1, (tick - tank.action.stateStartTick + 1) / duration),
      tank.body.y / 256 + 3,
    );
  }
}
