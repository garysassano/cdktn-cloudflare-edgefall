import { describe, expect, it } from "vitest";
import type { InputFrame } from "../src/game/protocol.js";
import {
  EMPTY_INPUT,
  addPlayer,
  createCompactSnapshot,
  createGame,
  setReady,
  startRun,
  stepGame,
} from "../src/game/simulation.js";

interface InFlightInput {
  deliverAt: number;
  input: InputFrame;
  playerId: string;
}

describe("simulated room latency", () => {
  it("keeps four-player authority deterministic at 100–150 ms with jitter and a short interruption", () => {
    const first = runNetworkModel();
    const second = runNetworkModel();
    expect(first).toEqual(second);
    expect(first.players).toHaveLength(4);
    expect(first.players.every((player) => player.acknowledgedInput >= 210)).toBe(true);
    expect(
      first.players.every((player) => Number.isFinite(player.x) && Number.isFinite(player.y)),
    ).toBe(true);
  });
});

function runNetworkModel() {
  const game = createGame("latency-proof");
  for (let slot = 0; slot < 4; slot += 1) {
    const id = `p${slot}`;
    addPlayer(game, id, `Player ${slot + 1}`);
    setReady(game, id, true);
  }
  startRun(game, "latency-proof-run");
  game.enemies = [];

  const baseLatency = [108, 120, 132, 140];
  const jitter = [-8, 0, 8, 10];
  const inFlight: InFlightInput[] = [];
  const latest: Record<string, InputFrame> = {};
  for (let tick = 0; tick < 225; tick += 1) {
    const sentAt = (tick * 1_000) / 30;
    for (let slot = 0; slot < 4; slot += 1) {
      if (slot === 0 && tick >= 60 && tick < 75) continue;
      const phase = Math.floor(tick / 24) % 2;
      const id = `p${slot}`;
      inFlight.push({
        deliverAt:
          sentAt + (baseLatency[slot] ?? 108) + (jitter[(tick + slot) % jitter.length] ?? 0),
        input: {
          ...EMPTY_INPUT,
          aimX: phase === 0 ? 1 : -1,
          fire: tick % (11 + slot) === 0,
          left: phase === 1,
          right: phase === 0,
          sequence: tick,
        },
        playerId: id,
      });
    }
    const serverTime = ((tick + 1) * 1_000) / 30;
    for (let index = inFlight.length - 1; index >= 0; index -= 1) {
      const candidate = inFlight[index];
      if (!candidate || candidate.deliverAt > serverTime) continue;
      const current = latest[candidate.playerId];
      if (!current || candidate.input.sequence > current.sequence)
        latest[candidate.playerId] = candidate.input;
      inFlight.splice(index, 1);
    }
    stepGame(game, latest);
  }
  return createCompactSnapshot(game);
}
