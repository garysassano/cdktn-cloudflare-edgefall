import { stateHash } from "../../src/game/core/canonical.js";
import { Held } from "../../src/game/input/types.js";
import { COMBAT_SCENARIOS, createCombatLab, stepCombatLab } from "../../src/game/labs/combat.js";

export function combatProof() {
  return COMBAT_SCENARIOS.map((scenario) => {
    let world = createCombatLab(scenario, 4),
      restored = structuredClone(world);
    const hashes: string[] = [],
      shots: number[] = [],
      kills: Array<{ tick: number; ownerId: number; targetId: number | null }> = [];
    let impacts = 0;
    for (let tick = 1; tick <= 120; tick++) {
      const inputs = world.players.map(() => ({
        held: tick <= 100 ? Held.Fire : 0,
        grenadePressed: false,
        firePressed: tick === 1,
        jumpPressed: false,
      }));
      world = stepCombatLab(world, inputs);
      restored = stepCombatLab(restored, inputs);
      if (stateHash(world) !== stateHash(restored))
        throw new Error(`Combat restore mismatch at ${scenario}:${tick}`);
      if ([1, 13, 37].includes(tick)) restored = JSON.parse(JSON.stringify(restored));
      hashes.push(stateHash(world));
      shots.push(world.events.filter((event) => event.kind === "shot").length);
      impacts += world.events.filter((event) => event.kind === "impact").length;
      for (const event of world.events)
        if (event.kind === "killed")
          kills.push({ tick, ownerId: event.ownerId, targetId: event.targetId });
    }
    return {
      scenario,
      ticks: world.tick,
      phase: world.encounter.phase,
      ammo: world.players.map((player) => player.weapon.ammo),
      shots: shots.reduce((sum, count) => sum + count, 0),
      impacts,
      kills,
      traceHash: stateHash(hashes),
      finalHash: stateHash(world),
    };
  });
}
