import { describe, it } from "vitest";
import {
  TANK_TERRAIN_CASES,
  assertTankTerrain,
  recordTankTerrain,
} from "./fixtures/tank-terrain-proof.js";

describe.each([1, 4])("tank terrain through the combat world, %i players", (players) => {
  it.each(TANK_TERRAIN_CASES)("%s", (name) => {
    assertTankTerrain(recordTankTerrain(name, players));
  });
});
