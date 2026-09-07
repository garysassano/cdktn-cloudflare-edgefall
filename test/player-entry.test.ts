import { describe, expect, it } from "vitest";
import { enterPlayer } from "../src/game/campaign/life.js";
import { pixels } from "../src/game/core/numeric.js";
import { combatEntryContext } from "../src/game/labs/combat.js";
import { combatCollisionIndex, combatEndTerrain } from "../src/game/labs/combat-terrain.js";
import { footActor } from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import { entryPhysicsProof } from "./fixtures/entry-proof.js";
import { entryRecoveryProof } from "./fixtures/entry-recovery-proof.js";

describe("protected entry physics", () => {
  it("places a moving respawn and an end-of-tick campaign reset at the same safe anchor", () => {
    const frame = { tick: 6, geometryRevision: 1 },
      actor = footActor(45, 160);
    const indexes = [
      combatCollisionIndex("ordnance", frame),
      new CollisionIndex(new CollisionGrid(combatEndTerrain("ordnance", 6)), [], frame),
    ];
    for (const index of indexes) {
      const entered = enterPlayer(
        actor,
        6,
        "classic",
        combatEntryContext(actor, index, frame, "ordnance"),
      );
      expect(entered?.body).toMatchObject({
        x: pixels(51),
        y: pixels(160),
        supportId: 102,
        grounded: true,
      });
    }
  });
  it("carries moving support, admits first-tick control once, and retries crush/void without spending lives", () => {
    const proof = entryPhysicsProof();
    expect(proof.carry.map((sample) => sample.kind)).toEqual(["solid", "one-way"]);
    expect(proof.ready).toMatchObject({ tick: 43, life: "alive", presence: "present", lives: 3 });
  });
  it("reconstructs four players through moving entry, a real press crush and safe reentry", async () => {
    const proof = await entryRecoveryProof();
    expect(proof.checkpoints).toHaveLength(10);
    expect(proof.duplicates).toBe(580);
    expect(proof.transitions.filter((event) => event.life === "death")).toHaveLength(4);
  });
});
