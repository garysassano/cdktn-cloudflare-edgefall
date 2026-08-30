import { describe, expect, it } from "vitest";
import { dailyDateFromRoom } from "../src/game/daily.js";
import { dailySeed } from "../src/game/simulation.js";

describe("Daily room routing", () => {
  it("gives private room suffixes one fixed date seed", () => {
    const first = dailyDateFromRoom("daily-20260830-crew1");
    const second = dailyDateFromRoom("daily-20260830-crew2");
    expect(first).toBe("2026-08-30");
    expect(second).toBe(first);
    expect(dailySeed(first ?? "")).toBe(dailySeed(second ?? ""));
  });

  it("does not treat ordinary or malformed invite codes as Daily runs", () => {
    expect(dailyDateFromRoom("cinder-rail-123")).toBeUndefined();
    expect(dailyDateFromRoom("daily-2026-08-30")).toBeUndefined();
    expect(dailyDateFromRoom("daily-20260231-crew1")).toBeUndefined();
  });
});
