import {
  type WeaponPickupDefinition,
  type WeaponPickupState,
  createWeaponPickups,
  stepWeaponPickups,
} from "../../src/game/combat/pickups.js";
import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import { Held } from "../../src/game/input/types.js";
import {
  type CombatLab,
  advanceCombatLab,
  combatTerrain,
  createCombatLab,
} from "../../src/game/labs/combat.js";
import { COMBAT_CATALOG } from "../../src/game/labs/combat-content.js";
import type { WeaponId } from "../../src/game/state.js";

/** Four actual controllers traverse all five finite weapon supplies, then exhaust the laser. */
export function weaponPickupProof() {
  const weapons: WeaponId[] = [
    "heavy-machine-gun",
    "shotgun",
    "flamethrower",
    "rocket-launcher",
    "laser",
  ];
  const definitions: WeaponPickupDefinition[] = weapons.flatMap((weaponId, source) =>
    Array.from({ length: 4 }, (_, slot) => ({
      id: 1400 + source * 4 + slot,
      claimId: 1400 + source * 4 + slot,
      sourceId: 1300 + source,
      kind: "weapon",
      weaponId,
      ammo: 2,
      ammoLimit: 2,
      activationTick: 1,
      expiresTick: 181,
      supportId: 100,
      rect: { x: pixels(84 + source * 48), y: pixels(177), w: pixels(24), h: pixels(23) },
    })),
  );
  const terrain = combatTerrain("range");
  const combat = createCombatLab("range", 4);
  for (const player of combat.players) player.weapon = { ...player.weapon, id: "sidearm", ammo: 0 };
  type State = { combat: CombatLab; supplies: WeaponPickupState };
  const states: State[] = [
    { combat, supplies: createWeaponPickups(definitions, COMBAT_CATALOG, terrain) },
  ];
  const advance = (current: State, reverse = false) => {
    const tick = current.combat.tick + 1;
    const commands = current.combat.players.map(() => ({
      held: tick <= 90 ? Held.Right : tick >= 100 ? Held.Up | Held.Fire : 0,
      firePressed: false,
      jumpPressed: false,
      grenadePressed: false,
      interactPressed: false,
    }));
    const result = advanceCombatLab(current.combat, commands);
    const pickups = stepWeaponPickups(
      current.supplies,
      reverse ? [...definitions].reverse() : definitions,
      reverse ? [...result.state.players].reverse() : result.state.players,
      result.playerMovement,
      terrain,
      COMBAT_CATALOG,
    );
    result.state.players = pickups.players.sort((a, b) => a.slot - b.slot);
    return { state: { combat: result.state, supplies: pickups.state }, claims: pickups.claims };
  };
  const claims = [],
    boundaries = new Set([0, 1, 89, 90, 99, 100, 105, 106, 107, 111, 112, 120, 159]);
  let traceHash = "0";
  for (let tick = 1; tick <= 180; tick++) {
    const previous = states[tick - 1];
    if (!previous) throw new Error("Missing pickup input boundary");
    const result = advance(previous);
    const reversed = advance(previous, true);
    if (canonical(result) !== canonical(reversed))
      throw new Error("Pickup input order changed authority");
    states.push(result.state);
    claims.push(...result.claims);
    if (result.claims.length) {
      boundaries.add(tick - 1);
      boundaries.add(tick);
    }
    traceHash = stateHash([traceHash, result]);
  }
  const checkpoints = [...boundaries]
    .sort((a, b) => a - b)
    .map((tick) => {
      const state = states[tick];
      if (!state) throw new Error("Missing pickup continuation");
      const bytes = JSON.stringify(state);
      let restored: State = JSON.parse(bytes);
      for (let next = tick + 1; next <= tick + 15; next++) restored = advance(restored).state;
      if (canonical(restored) !== canonical(states[tick + 15]))
        throw new Error("Pickup continuation diverged");
      return {
        tick,
        bytes: new TextEncoder().encode(bytes).length,
        hash: stateHash(state),
        resumedHash: stateHash(restored),
        contacts: state.supplies.contacts.length,
      };
    });
  const final = states.at(-1);
  if (!final) throw new Error("Missing final pickup state");
  if (
    claims.length !== 20 ||
    final.supplies.items.some((item) => item.status !== "claimed") ||
    final.combat.players.some(
      (p) => p.weapon.id !== "sidearm" || p.weapon.ammo !== 0 || p.lives !== 3,
    )
  )
    throw new Error("Supply route failed its inventory contract");
  const laserShots = states.flatMap(({ combat }) =>
    combat.events
      .filter((e) => e.kind === "shot" && e.source?.definitionId === 18)
      .map((event) => ({ tick: combat.tick, playerId: event.ownerId })),
  );
  if (laserShots.length !== 8) throw new Error("Pickup energy debit repeated");
  for (const player of final.combat.players) {
    if (claims.filter((c) => c.playerId === player.playerId).length !== weapons.length)
      throw new Error("Individual supply allocation diverged");
  }
  return {
    ticks: 180,
    claims,
    laserShots,
    checkpoints,
    traceHash,
    finalHash: stateHash(final),
    players: final.combat.players.map((p) => ({
      playerId: p.playerId,
      weapon: p.weapon,
      lives: p.lives,
    })),
    scope:
      "Actual controller paths, individual supply contention, finite weapon swaps, JSON continuation and empty fallback. No pickup wire/archive/SQLite or deployed-room claim.",
  };
}
