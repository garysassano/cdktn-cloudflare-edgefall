import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Held } from "../../src/game/input/types.js";
import type { CombatCommand } from "../../src/game/labs/combat.js";
import {
  type HarborCombat,
  type HarborCombatRecording,
  createHarborCombat,
  replayHarborCombat,
  stepHarborCombat,
} from "../../src/game/missions/harbor-combat.js";

export const harborIdle: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  interactPressed: false,
  specialPressed: false,
};
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Harbor infantry: ${message}`);
}

/** Continuous input from the mission entrance through the first hostile grenade and shared HMG cache. */
export function recordHarborInfantry(players: number) {
  let state = createHarborCombat(players),
    thrown = false,
    commandHash = stateHash([]);
  const commands: CombatCommand[][] = [],
    hashes: string[] = [stateHash(state)];
  const boundaries: Array<{ tick: number; state: HarborCombat }> = [];
  const throws: Array<{ tick: number; action: number; owner: number; began: number }> = [];
  const detonations: Array<{ tick: number; action: number; owner: number }> = [];
  const kills: Array<{ tick: number; target: number | null; owner: number }> = [];
  const save = () => boundaries.push({ tick: state.combat.tick, state: structuredClone(state) });
  save();
  let complete = false;
  while (state.combat.tick < 3000) {
    const tick = state.combat.tick;
    const grenadier = state.combat.targets.find((target) => target.enemy.body.id === 22);
    check(grenadier, "missing rooftop defender");
    const row = state.combat.players.map((player) => {
      const command = { ...harborIdle },
        x = player.body.x / 256,
        y = player.body.y / 256;
      const destination =
        grenadier.health > 0
          ? thrown
            ? grenadier.enemy.body.x / 256 - 30
            : 3148 + player.slot * 12
          : 4240;
      if (x < destination - 2) command.held |= Held.Right;
      else if (x > destination + 2) command.held |= Held.Left;
      if (x < 2940 || thrown) command.held |= Held.Fire;
      if (player.body.grounded && player.body.contacts.some((contact) => contact.normalX === -1))
        command.jumpPressed = true;
      if (thrown && grenadier.health > 0 && x > 3180 && player.body.grounded && y > 145)
        command.jumpPressed = true;
      if (
        player.body.grounded &&
        !command.jumpPressed &&
        state.combat.projectiles.some(
          (projectile) =>
            projectile.team === 2 &&
            Math.abs(projectile.position.x - player.body.x) < 110 * 256 &&
            (player.body.x - projectile.position.x) * projectile.velocity.x > 0 &&
            projectile.position.y > player.body.y - 35 * 256 &&
            projectile.position.y < player.body.y - 16 * 256,
        )
      )
        command.held |= Held.Down;
      return command;
    });
    const previous = state,
      before = stateHash(state);
    state = stepHarborCombat(state, row);
    check(
      stateHash(previous) === before && before === hashes[tick],
      "accepted input boundary changed",
    );
    commands.push(row);
    commandHash = stateHash([commandHash, row]);
    hashes.push(stateHash(state));
    for (const event of state.combat.events) {
      if (event.kind === "throw" && event.ownerId >= 20) {
        check(event.source && "stateStartTick" in event.source, "missing throw origin");
        throws.push({
          tick: state.combat.tick,
          action: event.actionInstanceId,
          owner: event.ownerId,
          began: event.source.stateStartTick,
        });
        if (event.ownerId === 22) thrown = true;
        save();
      }
      if (event.kind === "explosion" && event.ownerId >= 20)
        detonations.push({
          tick: state.combat.tick,
          action: event.actionInstanceId,
          owner: event.ownerId,
        });
      if (event.kind === "killed" && event.targetId !== null && event.targetId >= 20)
        kills.push({ tick: state.combat.tick, target: event.targetId, owner: event.ownerId });
    }
    if ([300, 600, 900, 1200, 1500, 1800, 2400].includes(state.combat.tick)) save();
    complete =
      state.combat.players.every((player) => player.weapon.id === "heavy-machine-gun") &&
      [20, 21, 22, 23].every((id) =>
        state.combat.targets.some((target) => target.enemy.body.id === id && target.health === 0),
      );
    if (complete) break;
  }
  check(
    complete,
    `opening not cleared: players ${state.combat.players.map((p) => `${p.body.x / 256},${p.body.y / 256},${p.life},${p.weapon.id}`).join(";")}; targets ${state.combat.targets
      .slice(0, 4)
      .map((t) => `${t.enemy.body.id}:${t.health}@${t.enemy.body.x / 256},${t.enemy.body.y / 256}`)
      .join(";")}; thrown ${thrown}`,
  );
  check(thrown, "route bypassed the hostile throw");
  const firstThrow = throws.find((entry) => entry.owner === 22);
  const killed = kills.find((entry) => entry.target === 22);
  check(firstThrow && killed, "missing grenade/owner timeline");
  check(firstThrow.tick - firstThrow.began === 36, "missing complete throw warning");
  const explosions = detonations.filter(
    (entry) => entry.action === firstThrow.action && entry.owner === 22,
  );
  check(
    explosions.length === 1 &&
      explosions[0] &&
      explosions[0].tick === firstThrow.tick + 90 &&
      killed.tick < explosions[0].tick,
    "released grenade did not survive its owner through one complete fuse",
  );
  check(
    state.combat.props.every((prop) => prop.health === 0),
    "route bypassed destructibles",
  );
  check(
    state.combat.players.every((player) => player.life === "alive" && player.lives === 3),
    "opening consumed a life",
  );
  const continuations = boundaries
    .filter((entry) => entry.tick + 8 <= state.combat.tick)
    .map((entry) => {
      let restored = JSON.parse(JSON.stringify(entry.state)) as HarborCombat;
      for (let tick = entry.tick; tick < entry.tick + 8; tick++) {
        const command = commands[tick];
        check(command, "missing accepted input");
        restored = stepHarborCombat(restored, command);
      }
      check(stateHash(restored) === hashes[entry.tick + 8], "JSON continuation diverged");
      return { tick: entry.tick, hash: stateHash(restored) };
    });
  const recording: HarborCombatRecording = {
    format: 1,
    contentHash: state.contentHash,
    players,
    commands,
    finalState: canonical(state),
  };
  check(
    canonical(replayHarborCombat(recording)) === recording.finalState,
    "full recording replay diverged",
  );
  return {
    players,
    ticks: state.combat.tick,
    contentHash: state.contentHash,
    finalHash: stateHash(state),
    commandHash,
    lives: state.combat.players.map((p) => p.lives),
    supplies: state.combat.pickupClaims,
    claimed: state.combat.pickups.items.filter((item) => item.status === "claimed"),
    throws,
    detonations,
    kills,
    continuations,
  };
}

export function harborInfantryProof() {
  return [1, 2, 4].map(recordHarborInfantry);
}
