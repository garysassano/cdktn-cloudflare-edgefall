import { describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import {
  createHarborCombat,
  harborCombatStage,
  stepHarborCombat,
} from "../src/game/missions/harbor-combat.js";
import { HARBOR } from "../src/game/missions/harbor-content.js";
import { harborIdle, recordHarborInfantry } from "./fixtures/harbor-combat-proof.js";

describe("Harbor infantry and supplies", () => {
  it("starts every participant with the mission sidearm and six grenades", () => {
    const state = createHarborCombat(4);
    expect(
      state.combat.players.map((player) => [
        player.weapon.id,
        player.weapon.ammo,
        player.grenadeStock,
      ]),
    ).toEqual(Array.from({ length: 4 }, () => ["sidearm", 0, 6]));
  });
  it.each([1, 2, 4])(
    "clears the continuous opening with %i players and replays its exact accepted inputs",
    { timeout: 30_000 },
    (players) => {
      const result = recordHarborInfantry(players);
      expect(result.claimed).toHaveLength(players);
      expect(result.lives).toEqual(Array.from({ length: players }, () => 3));
      expect(result.throws.some((entry) => entry.owner === 22)).toBe(true);
      expect(result.kills.map((entry) => entry.target)).toEqual(
        expect.arrayContaining([20, 21, 22, 23]),
      );
    },
  );

  it("keeps sleeping infantry stationary and activates authored encounters as players approach", () => {
    const initial = createHarborCombat(4);
    let next = initial;
    for (let tick = 0; tick < 20; tick++)
      next = stepHarborCombat(
        next,
        next.combat.players.map(() => harborIdle),
      );
    expect(next.combat.targets).toEqual(initial.combat.targets);
    expect(next.combat.encounter.members.every((member) => member.status === "pending")).toBe(true);
    expect(
      next.grenadiers.every(
        (grenadier) => grenadier.state.tick === 20 && grenadier.state.phase === "patrol",
      ),
    ).toBe(true);
    const leader = next.combat.players[0];
    if (!leader) throw new Error("Missing leader");
    leader.body.x = pixels(1568);
    next = stepHarborCombat(
      next,
      next.combat.players.map(() => harborIdle),
    );
    expect(next.combat.encounter.members.find((member) => member.id === 20)?.status).toBe("alive");
    expect(next.combat.encounter.members.find((member) => member.id === 21)?.status).toBe(
      "pending",
    );
  });

  it.each([1, 2, 4])(
    "gives %i players actual shared HMG, shotgun and rocket supplies once",
    (players) => {
      let state = createHarborCombat(players);
      for (const supply of HARBOR.supplies) {
        for (const player of state.combat.players) {
          player.body.x = pixels(supply.x);
          player.body.y = pixels(supply.y);
          player.body.supportId = supply.supportId;
        }
        state = stepHarborCombat(
          state,
          state.combat.players.map(() => harborIdle),
        );
        expect(state.combat.pickupClaims).toHaveLength(players);
        expect(
          state.combat.players.every(
            (player) => player.weapon.id === supply.weapon && player.weapon.ammo === supply.ammo,
          ),
        ).toBe(true);
        state = stepHarborCombat(
          state,
          state.combat.players.map(() => harborIdle),
        );
        expect(state.combat.pickupClaims).toHaveLength(0);
      }
    },
  );

  it("rejects altered mission content and missing grenade owners without mutating the accepted state", () => {
    const initial = createHarborCombat(),
      before = canonical(initial);
    expect(() => stepHarborCombat({ ...initial, contentHash: "old" }, [harborIdle])).toThrow(
      "content mismatch",
    );
    expect(() => stepHarborCombat({ ...initial, grenadiers: [] }, [harborIdle])).toThrow(
      "roster mismatch",
    );
    expect(() => stepHarborCombat(initial, [])).toThrow("Missing combat input");
    expect(canonical(initial)).toBe(before);
    expect(harborCombatStage(initial).pickups).toHaveLength(3);
  });
});
