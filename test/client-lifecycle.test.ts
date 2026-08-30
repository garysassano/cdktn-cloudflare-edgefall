import { describe, expect, it, vi } from "vitest";

vi.mock("phaser", () => ({
  default: {
    Scene: class {},
  },
}));

describe("client scene lifecycle", () => {
  it("accepts presentation settings before Phaser creates the scene", async () => {
    const { EdgefallScene } = await import("../src/client/scene.js");
    const scene = new EdgefallScene();

    expect(() =>
      scene.setPresentationSettings({
        contrast: false,
        flashes: true,
        reduceMotion: false,
        shake: true,
        volume: 0.7,
      }),
    ).not.toThrow();
  });
});
