import { describe, expect, it } from "vitest";
import { damagePlayer, stepPlayerLife, validatePlayerLife } from "../src/game/campaign/life.js";
import { stepFootController } from "../src/game/controller/foot.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { FOOT_FLOOR, footTerrain } from "../src/game/labs/foot-fixture.js";
import { airborneDeathRecoveryProof } from "./fixtures/airborne-death-recovery-proof.js";
import { airbornePlayer, deathBodyProof, deathContext } from "./fixtures/death-body-proof.js";

describe("authoritative dead body motion", () => {
  it("preserves real rising/falling enemy kills through four-player admission, snapshots, checkpoints and committed journals", async () => {
    const proof = await airborneDeathRecoveryProof();
    expect(proof.cases.map((c) => [c.kind, c.deathTick, c.landedTick])).toEqual([
      ["rising", 37, null],
      ["falling", 77, 81],
    ]);
    expect(proof.cases.every((c) => c.duplicates === 580 && c.checkpoints.length === 6)).toBe(true);
  });
  it("lands on floors and one-ways, rides platforms, loses support, retires on crush/void and retries entry without another life debit", () => {
    expect(deathBodyProof().cases.map((c) => c.name)).toEqual([
      "solid",
      "one-way",
      "platform-and-support-loss",
      "crush",
      "void-and-entry-retry",
    ]);
  });
  it("blocks wall and ceiling motion through sweeps while refusing player control", () => {
    const initial = airbornePlayer(0, -8, 8, -8);
    const killed = damagePlayer(initial, 0, 1, "classic").actor;
    const context = deathContext(1, [
      FOOT_FLOOR,
      footTerrain(101, 10, -100, 5, 100),
      footTerrain(102, -100, -50, 200, 5),
    ]);
    const result = stepPlayerLife(killed, 1, "classic", context);
    expect(result.actor.body).toMatchObject({ x: pixels(3), y: pixels(-11), vx: 0, vy: 0 });
    expect(result.actor.bodyPresence).toBe("present");
    const input = stepFootController(
      result.actor,
      { held: Held.Left | Held.Fire, jumpPressed: true },
      context.definition,
      context.shapes,
      context.index,
      context.frame,
    );
    expect(input.status).toBe("inactive");
    if (input.status === "failed") throw new Error("Unexpected inactive solver");
    expect(input.actor).toEqual(result.actor);
    expect(initial.life).toBe("alive");
  });
  it("removes a lethal fall immediately and rejects inconsistent restored bodies or unsupported physics", () => {
    const actor = damagePlayer(airbornePlayer(), 0, 1, "classic", "fall").actor;
    expect(actor).toMatchObject({
      bodyPresence: "removed",
      lives: 2,
      body: { vx: 0, vy: 0, supportId: null, grounded: false, contacts: [] },
    });
    const missing = JSON.parse(JSON.stringify(actor));
    delete missing.bodyPresence;
    expect(() => validatePlayerLife(missing, 0, "classic")).toThrow(/body presence/);
    expect(() =>
      validatePlayerLife({ ...actor, body: { ...actor.body, vx: 1 } }, 0, "classic"),
    ).toThrow(/body presence/);
    expect(() =>
      validatePlayerLife({ ...airbornePlayer(), bodyPresence: "removed" }, 0, "classic"),
    ).toThrow(/body presence/);
    const present = damagePlayer(airbornePlayer(), 0, 1, "classic").actor;
    const context = deathContext(1);
    expect(() =>
      stepPlayerLife(present, 1, "classic", {
        ...context,
        definition: { ...context.definition, gravity: 0 },
      }),
    ).toThrow(/physics/);
    expect(() =>
      stepPlayerLife(
        { ...present, body: { ...present.body, remainderX: 1 } },
        1,
        "classic",
        context,
      ),
    ).toThrow(/remainder/);
  });
});
