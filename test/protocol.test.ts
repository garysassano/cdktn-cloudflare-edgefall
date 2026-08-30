import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, isClientMessage } from "../src/game/protocol.js";
import { EMPTY_INPUT } from "../src/game/simulation.js";

describe("versioned room protocol", () => {
  it.each([
    { name: "Rook", type: "join", v: PROTOCOL_VERSION },
    { resumeToken: "a".repeat(32), type: "resume", v: PROTOCOL_VERSION },
    {
      selection: { operator: "vale", ordnance: "arc-mine", outfit: "foundry", primary: "beam" },
      type: "selection",
      v: PROTOCOL_VERSION,
    },
    { ready: true, type: "ready", v: PROTOCOL_VERSION },
    { input: EMPTY_INPUT, type: "input", v: PROTOCOL_VERSION },
    { choice: "beam-prism", type: "upgrade-choice", v: PROTOCOL_VERSION },
    { type: "rematch", v: PROTOCOL_VERSION },
  ])("accepts $type messages", (message) => {
    expect(isClientMessage(message)).toBe(true);
  });

  it("rejects old versions, invalid axes, and malformed selections", () => {
    expect(isClientMessage({ input: EMPTY_INPUT, type: "input", v: 1 })).toBe(false);
    expect(isClientMessage({ input: { ...EMPTY_INPUT, aimX: 4 }, type: "input", v: 2 })).toBe(
      false,
    );
    expect(
      isClientMessage({
        selection: {
          operator: "borrowed-hero",
          ordnance: "arc-mine",
          outfit: "field",
          primary: "beam",
        },
        type: "selection",
        v: 2,
      }),
    ).toBe(false);
  });
});
