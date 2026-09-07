import { canonical } from "../../src/game/core/canonical.js";
import { Held } from "../../src/game/input/types.js";
import type { CombatCommand } from "../../src/game/labs/combat.js";
import {
  type BreakwaterMission,
  type BreakwaterRecording,
  createBreakwater,
  stepBreakwater,
} from "../../src/game/missions/breakwater.js";
import { BREAKWATER } from "../../src/game/missions/breakwater-content.js";

/** A continuous solo input demonstration. The director can inspect state but never writes it. */
export function runBreakwaterProof(observe?: (state: BreakwaterMission) => void) {
  let state = createBreakwater(),
    phase = 0,
    began = 0;
  const commands: CombatCommand[][] = [],
    landmarks: Array<{ phase: number; tick: number }> = [];
  const begin = (next: number) => {
    phase = next;
    began = state.combat.tick;
    landmarks.push({ phase, tick: began });
  };
  observe?.(structuredClone(state));
  while (state.combat.tick < BREAKWATER.maxTicks && state.phase === "playing") {
    const tick = state.combat.tick,
      player = state.combat.players[0];
    if (!player) throw new Error("Missing demonstration player");
    const x = player.body.x / 256,
      y = player.body.y / 256,
      age = tick - began,
      tank = state.combat.tanks[0];
    if (!tank) throw new Error("Missing demonstration tank");
    const target = (id: number) => {
      const enemy = state.combat.targets.find((t) => t.enemy.body.id === id);
      if (!enemy) throw new Error("Missing demonstration defender");
      return enemy;
    };
    let held = 0,
      firePressed = false,
      jumpPressed = false,
      grenadePressed = false,
      interactPressed = false;
    const go = (destination: number) => {
      if (x < destination - 2) held |= Held.Right;
      else if (x > destination + 2) held |= Held.Left;
    };
    const fire = () => {
      held |= Held.Fire;
      firePressed = tick % 8 === 0;
    };
    switch (phase) {
      case 0:
        if (tick < 100) go(240);
        else if (tick < 150) {
          held |= Held.Down;
          jumpPressed = tick === 110;
        } else if (tick < 210) go(150);
        else if (tick < 270) {
          held |= Held.Up;
          fire();
        } else if (tick < 340) {
          held |= Held.Down;
          fire();
        } else if (tick < 400) {
          go(320);
          jumpPressed = tick === 350;
        } else go(390);
        if (tick >= 600) begin(1);
        break;
      case 1:
        go(570);
        interactPressed = age % 8 === 0;
        fire();
        if (target(20).health === 0 && player.weapon.id === "heavy-machine-gun") begin(2);
        break;
      case 2:
        go(675);
        if (age < 36 || age > 66) fire();
        grenadePressed = age >= 40 && age < 54;
        jumpPressed = x >= 657 && player.body.grounded && age >= 80 && age % 30 === 0;
        if (target(21).health === 0) begin(3);
        break;
      case 3:
        go(810);
        if (y < 195 && player.body.grounded) {
          held |= Held.Down;
          jumpPressed = true;
        }
        if (y > 190) interactPressed = age % 8 === 0;
        if (player.weapon.id === "shotgun") begin(4);
        break;
      case 4:
        fire();
        jumpPressed = player.body.grounded && target(22).guard?.phase === "bash";
        if (!player.body.grounded) {
          go(target(22).enemy.body.x / 256);
          held |= Held.Down;
        }
        if (target(22).health === 0) begin(5);
        break;
      case 5: {
        const rifle = target(23);
        go(rifle.health > 0 ? rifle.enemy.body.x / 256 - 65 : 1125);
        fire();
        if (rifle.health > 0 && Math.abs(x - rifle.enemy.body.x / 256) < 90) held |= Held.Down;
        interactPressed = age % 8 === 0;
        if (player.weapon.id === "flamethrower") begin(6);
        break;
      }
      case 6:
        go(1200);
        fire();
        if (target(24).health === 0) begin(7);
        break;
      case 7:
        go(1280);
        fire();
        if (state.combat.props[0]?.health === 0) begin(8);
        break;
      case 8:
        go(1510);
        if (x > 1370 && x < 1415) interactPressed = age % 8 === 0;
        if (x >= 1490 && player.vehicleId === null) interactPressed = age % 20 === 0;
        if (player.vehicleId !== null) begin(9);
        break;
      case 9:
        go(1710);
        fire();
        if (x > 1660 && tank.body.grounded) jumpPressed = age % 30 === 0;
        if (x >= 1708) begin(10);
        break;
      case 10:
        go(2050);
        fire();
        jumpPressed = tank.body.grounded && x < 1845 && age % 30 === 0;
        if (x >= 2048) begin(11);
        break;
      case 11:
        go(target(27).health > 0 ? 2070 : 2450);
        fire();
        if (x >= 2448) begin(12);
        break;
      case 12:
        go(2680);
        if (x >= 2678) begin(13);
        break;
      case 13:
        if (player.vehicleId !== null) {
          if (tank.armor === 1) interactPressed = age % 10 === 0;
        } else {
          held |= Held.Down;
          if (tank.armor === 0) begin(14);
        }
        break;
      case 14:
        held |= Held.Down;
        interactPressed = age % 8 === 0;
        if (player.weapon.id === "heavy-machine-gun") begin(15);
        break;
      case 15:
        if (state.boss.phase === "recovery" && tick - state.boss.phaseStartTick >= 20) fire();
        else {
          held |= Held.Down;
          if (age < 16) fire();
        }
        break;
      default:
        throw new Error("Unknown demonstration phase");
    }
    if (
      phase === 5 &&
      player.body.grounded &&
      !(held & Held.Down) &&
      state.combat.projectiles.some(
        (b) =>
          b.team === 2 &&
          b.velocity.x < 0 &&
          b.position.x / 256 > x &&
          b.position.x / 256 < x + 90 &&
          b.position.y / 256 > y - 35,
      )
    )
      jumpPressed = true;
    const row = [{ held, firePressed, jumpPressed, grenadePressed, interactPressed }];
    state = stepBreakwater(state, row);
    commands.push(row);
    observe?.(structuredClone(state));
  }
  const recording: BreakwaterRecording = {
    format: 1,
    contentHash: state.contentHash,
    seed: state.seed,
    players: state.combat.players.length,
    commands,
    finalState: canonical(state),
  };
  return { state, recording, landmarks };
}
