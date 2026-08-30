import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("browser vertical-slice shell", () => {
  it("ships lobby, loadout, reward, result, leaderboard, and accessibility surfaces", async () => {
    const html = await readFile(new URL("../src/client/index.html", import.meta.url), "utf8");
    for (const id of [
      "landing",
      "lobby",
      "readyButton",
      "reward",
      "results",
      "boards",
      "copyResultButton",
      "settings",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-operator="rook"');
    expect(html).toContain('data-operator="vale"');
    expect(html).toContain("gamepad supported");
    expect(html).toContain("Reduce background motion");
    expect(html).toContain("Bright combat flashes");
    expect(html).toContain("High-contrast team outlines");
  });

  it("declares the D1 profile, unlock, run, party, and leaderboard schema", async () => {
    const migration = await readFile(
      new URL("../migrations/0001_profiles_runs_and_unlocks.sql", import.meta.url),
      "utf8",
    );
    for (const table of ["profiles", "unlocks", "runs", "run_players"]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(migration).toContain("runs_normal_board");
    expect(migration).toContain("runs_daily_board");
  });

  it("emits one ready transition and creates a private room for each Daily crew", async () => {
    const source = await readFile(new URL("../src/client/index.ts", import.meta.url), "utf8");
    expect(source.match(/connection\.send\(\{ ready:/gu)).toHaveLength(1);
    expect(source).toMatch(/return `daily-\$\{date\}-\$\{random\.toString\(36\)/u);
  });
});
