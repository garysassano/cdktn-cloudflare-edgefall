import { describe, expect, it } from "vitest";
import {
  BASELINE_SCENARIOS,
  advanceBaseline,
  createBaselineScenario,
} from "../src/game/labs/baseline.js";

describe("v2 baseline reproductions (known defects, not acceptance tests)", () => {
  it("observes a ground enemy walking beyond its ledge without falling", () => {
    const game = createBaselineScenario("enemy-ledge");
    for (let tick = 0; tick < 30; tick++) advanceBaseline(game, "enemy-ledge");
    const enemy = game.enemies[0];
    expect(enemy?.x).toBeGreaterThan(200);
    expect(enemy?.y).toBe(200);
    expect(enemy?.vy).toBe(0);
  });

  it("observes a fast shot crossing a thin crate without damage", () => {
    const game = createBaselineScenario("thin-obstacle");
    advanceBaseline(game, "thin-obstacle");
    expect(game.projectiles[0]?.x).toBeGreaterThan(115);
    expect(game.destructibles[0]?.hp).toBe(30);
    expect(game.events.some((event) => event.type === "hit")).toBe(false);
  });

  it.each(BASELINE_SCENARIOS)("reproduces %s identically at every tick", (scenario) => {
    const first = createBaselineScenario(scenario);
    const second = createBaselineScenario(scenario);
    for (let tick = 0; tick < 90; tick++) {
      advanceBaseline(first, scenario);
      advanceBaseline(second, scenario);
      expect(first).toEqual(second);
    }
  });
});
