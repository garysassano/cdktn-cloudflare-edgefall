import { beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import {
  COMBAT_ARCHIVE_MAX_BYTES,
  type CombatArchiveIdentity,
  decodeCombatCheckpoint,
  encodeAcceptedCombatJournalSegment,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../src/shared/diagnostics/combat-checkpoint.js";
import {
  type CombatRuntime,
  combatRuntimeHash,
  replayCombatTick,
} from "../src/shared/diagnostics/combat-runtime.js";
import {
  combatArchiveIdentity,
  combatRecoveryProof,
  recordCombatRecovery,
} from "./fixtures/combat-recovery-proof.js";
import { playerLifeRecoveryProof } from "./fixtures/player-life-recovery-proof.js";

let identity: CombatArchiveIdentity;
let fixture: ReturnType<typeof recordCombatRecovery>;
beforeAll(async () => {
  identity = await combatArchiveIdentity();
  fixture = recordCombatRecovery();
});
function state(tick = 60): CombatRuntime {
  const value = fixture.states[tick];
  if (!value) throw new Error("Missing recovery fixture");
  return structuredClone(value);
}
describe("combat checkpoint and committed applied-input journal", () => {
  it("restores spent lives and remaining death/entry delays from full checkpoints and committed inputs", async () => {
    const proof = await playerLifeRecoveryProof();
    expect(proof.entryTick - proof.deathTick).toBe(30);
    expect(proof.checkpoints.map((c) => c.players[0]?.life)).toEqual([
      "death",
      "alive",
      "spectating",
    ]);
    expect(
      proof.checkpoints.at(-1)?.players.every((p) => p.lives === 0 && p.life === "spectating"),
    ).toBe(true);
  });
  it("captures the accepted boundary immutably and checks its complete hash chain", async () => {
    const start = state(60),
      accepted = state(75),
      entries = structuredClone(fixture.entries.slice(60, 75));
    const pending = encodeAcceptedCombatJournalSegment(start, entries, accepted, identity);
    accepted.combat.nextActionId++;
    entries.pop();
    const raw = await pending;
    expect(raw).toBe(
      await encodeCombatJournalSegment(state(60), fixture.entries.slice(60, 75), identity),
    );
    expect(await restoreCombatJournalSegment(state(60), raw, identity)).toEqual(state(75));
    await expect(
      encodeAcceptedCombatJournalSegment(
        state(60),
        fixture.entries.slice(60, 75),
        state(74),
        identity,
      ),
    ).rejects.toThrow(/boundary/);
    const changed = structuredClone(fixture.entries.slice(60, 75));
    if (!changed[4]) throw new Error("Missing journal fixture");
    changed[4].beforeHash = "00000000";
    await expect(
      encodeAcceptedCombatJournalSegment(state(60), changed, state(75), identity),
    ).rejects.toThrow(/prefix/);
  });
  it("resimulates archived decisions on load even when the captured boundary hash matches", async () => {
    const entries = structuredClone(fixture.entries.slice(60, 75));
    const input = entries[2]?.inputs[0]?.input;
    if (!input) throw new Error("Missing journal fixture");
    input.command.held = 0;
    // Only the coordinated authority may capture accepted entries. A changed decision with a valid
    // envelope checksum and unchanged asserted hashes still fails semantic reconstruction at load.
    const raw = await encodeAcceptedCombatJournalSegment(state(60), entries, state(75), identity);
    await expect(restoreCombatJournalSegment(state(60), raw, identity)).rejects.toThrow();
  });
  it("reconstructs the exact committed world including private continuation and excludes uncommitted ticks", async () => {
    expect(await combatRecoveryProof()).toMatchObject({
      checkpointTick: 60,
      committedTick: 105,
      observedTick: 119,
      uncommittedTicks: 14,
      connectedPlayerIds: [1, 2, 3],
      kills: [
        { playerId: 1, count: 0 },
        { playerId: 2, count: 2 },
        { playerId: 3, count: 0 },
        { playerId: 4, count: 0 },
      ],
    });
  });
  it("captures immutably before asynchronous digesting and restores before/after terminal kills", async () => {
    for (const tick of [0, 8, 10, 18, 60]) {
      const value = state(tick),
        saved = structuredClone(value);
      const pending = encodeCombatCheckpoint(value, identity);
      value.combat.nextActionId += 50;
      expect(await decodeCombatCheckpoint(await pending, identity)).toEqual(saved);
    }
    const start = state(8);
    const checkpoint = await decodeCombatCheckpoint(
      await encodeCombatCheckpoint(start, identity),
      identity,
    );
    const segment = await encodeCombatJournalSegment(start, fixture.entries.slice(8, 23), identity);
    expect(await restoreCombatJournalSegment(checkpoint, segment, identity)).toEqual(state(23));
  });
  it("rejects unknown versions, identities, corrupt checksums and oversized archives", async () => {
    const raw = await encodeCombatCheckpoint(state(), identity);
    for (const format of [1, 2, 3, 4]) {
      const old = { ...JSON.parse(raw), format };
      await expect(decodeCombatCheckpoint(JSON.stringify(old), identity)).rejects.toThrow(
        /version/,
      );
    }
    await expect(
      decodeCombatCheckpoint(raw, { ...identity, contentHash: "a".repeat(64) }),
    ).rejects.toThrow(/identity/);
    for (const field of ["format", "protocolMinor", "kind", "sha256", "payload"]) {
      const corrupt = JSON.parse(raw);
      corrupt[field] = field === "payload" ? `${corrupt.payload} ` : "invalid";
      await expect(decodeCombatCheckpoint(JSON.stringify(corrupt), identity)).rejects.toThrow();
    }
    await expect(
      decodeCombatCheckpoint("x".repeat(COMBAT_ARCHIVE_MAX_BYTES + 1), identity),
    ).rejects.toThrow(/size/);
  });
  it("rejects private state, receipt and event-ring corruption before checkpointing", async () => {
    const mutations: Array<(s: CombatRuntime) => void> = [
      (s) => {
        if (s.combat.players[0]) s.combat.players[0].action.nextMarkerIndex = 0;
      },
      (s) => {
        if (s.combat.targets[0]) s.combat.targets[0].enemy.turns = -1;
      },
      (s) => {
        if (s.combat.targets[0]) s.combat.targets[0].enemy.life = "alive";
      },
      (s) => {
        if (s.combat.targets[0]) s.combat.targets[0].enemy.body.supportId = null;
      },
      (s) => {
        s.combat.encounter.receipts[0] = "{}";
      },
      (s) => {
        s.combat.eventSequence++;
      },
      (s) => {
        if (s.combat.encounter.members[0]) s.combat.encounter.members[0].unchangedSince = 61;
      },
      (s) => {
        if (s.combat.projectiles[0]) s.combat.projectiles[0].team = 2;
      },
      (s) => {
        s.history.entries.shift();
      },
      (s) => {
        if (s.history.entries[0]) s.history.entries[0].counter = 900;
      },
      (s) => {
        s.connectedPlayerIds.push(4);
      },
      (s) => {
        s.snapshot.stateHash++;
      },
    ];
    for (const mutate of mutations) {
      const saved = state();
      mutate(saved);
      await expect(encodeCombatCheckpoint(saved, identity)).rejects.toThrow();
    }
  });
  it("fails closed on gaps, duplicates, reordered decisions and changed acknowledgments/outcomes", async () => {
    const start = state();
    const segment = await encodeCombatJournalSegment(
      start,
      fixture.entries.slice(60, 75),
      identity,
    );
    await expect(restoreCombatJournalSegment(state(59), segment, identity)).rejects.toThrow(/gap/);
    await expect(restoreCombatJournalSegment(state(75), segment, identity)).rejects.toThrow(/gap/);
    await expect(
      encodeCombatJournalSegment(start, fixture.entries.slice(60, 76), identity),
    ).rejects.toThrow();
    await expect(encodeCombatJournalSegment(start, [], identity)).rejects.toThrow();
    for (const kind of ["ack", "input", "outcome", "hash", "boundary"]) {
      const entry = structuredClone(fixture.entries[62]);
      if (!entry?.inputs[0] || !entry.acknowledgments[0])
        throw new Error("Missing journal fixture");
      if (kind === "ack") entry.acknowledgments[0].lastProcessedSequence--;
      if (kind === "input") entry.inputs[0].input.command.held = 0;
      if (kind === "outcome") entry.inputs[0].edgeResults = [];
      if (kind === "hash") entry.assertions[0] = { kind: "state-hash", value: "00000000" };
      if (kind === "boundary")
        entry.boundaryEvents.push({
          order: 0,
          event: { kind: "geometry", revision: 2, removedIds: [] },
        });
      const previous = state(62),
        before = canonical(previous);
      expect(() => replayCombatTick(previous, entry)).toThrow();
      expect(canonical(previous)).toBe(before);
      expect(combatRuntimeHash(previous)).toBe(combatRuntimeHash(state(62)));
    }
  });
});
