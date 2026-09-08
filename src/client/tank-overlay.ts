import type Phaser from "phaser";
import { COMBAT_SHAPES, TANK_PROFILE } from "../game/labs/combat-content.js";
import { worldRect, worldSocket } from "../game/physics/body.js";
import type { VehicleState } from "../game/state.js";
import { tankCannonPose } from "../shared/animation/tank-cannon.js";

/** Engineering collision/ownership inspection; these shapes are not final game media. */
export function drawTankOverlay(g: Phaser.GameObjects.Graphics, tank: VehicleState, tick: number) {
  const shape = COMBAT_SHAPES.get(tank.body.shapeId),
    heading = TANK_PROFILE.headings[tank.heading];
  if (!shape || !heading) return;
  const r = worldRect(tank.body, shape.rect, tank.facing),
    owner = tank.occupantId ?? tank.reservedBy;
  const color =
    tank.special.phase === "charging"
      ? 0xff6655
      : tank.lifecycle === "wreck"
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
    const cannon = tankCannonPose(tank, tick, TANK_PROFILE.cannon);
    g.lineStyle(4, 0xffcc88);
    g.lineBetween(
      cannon.root.x / 256,
      cannon.root.y / 256,
      cannon.muzzle.x / 256,
      cannon.muzzle.y / 256,
    );
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
    g.lineStyle(2, 0xffe475);
    const duration = tank.lifecycle === "boarding" ? 12 : 8;
    g.lineStyle(2, 0xffe475);
    g.lineBetween(
      r.x / 256,
      tank.body.y / 256 + 3,
      r.x / 256 + (r.w / 256) * Math.min(1, (tick - tank.action.stateStartTick + 1) / duration),
      tank.body.y / 256 + 3,
    );
  }
  if (tank.special.phase === "arming") {
    const progress = Math.min(
      1,
      (tick - tank.special.startTick + 1) / TANK_PROFILE.special.armTicks,
    );
    g.fillStyle(0x303946);
    g.fillRect(r.x / 256, tank.body.y / 256 - 44, r.w / 256, 3);
    g.fillStyle(tick % 10 < 5 ? 0xff6655 : 0xffcc88);
    g.fillRect(r.x / 256, tank.body.y / 256 - 44, (r.w / 256) * progress, 3);
  }
  for (let shell = 0; shell < TANK_PROFILE.cannon.stock; shell++) {
    g.fillStyle(shell < tank.secondary.ammo ? 0xffcc88 : 0x303946);
    g.fillRect(tank.body.x / 256 - 19 + shell * 4, tank.body.y / 256 - 38, 2, 3);
  }
}
