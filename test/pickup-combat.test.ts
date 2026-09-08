import { beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { combatEventContext } from "../src/shared/diagnostics/combat-events.js";
import { transitionCombatRuntime } from "../src/shared/diagnostics/combat-recovery.js";
import {
  type CombatRuntime,
  createCombatRuntime,
  stageCombatRuntime,
} from "../src/shared/diagnostics/combat-runtime.js";
import {
  combatPeerContext,
  combatSnapshot,
  validateCombatGeometryTransition,
} from "../src/shared/diagnostics/combat-workload.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import { EventReceiver, eventBatches } from "../src/shared/protocol/event-stream.js";
import {
  type GameplayEvent,
  decodeEventBatch,
  encodeEventBatch,
  validateGameplayEvent,
} from "../src/shared/protocol/events.js";
import { InputStream } from "../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./fixtures/combat-input-driver.js";
import {
  PICKUP_COMBAT_BOUNDARIES,
  pickupCombatProof,
  recordPickupCombat,
} from "./fixtures/pickup-combat-proof.js";
import { recordSupport } from "./fixtures/support-proof.js";

const idle = {
  held: 0,
  firePressed: false,
  jumpPressed: false,
  grenadePressed: false,
  interactPressed: false,
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing pickup fixture value");
  return value;
}
let fixture: ReturnType<typeof recordPickupCombat>;
beforeAll(() => {
  fixture = recordPickupCombat();
});
const stateAt = (tick: number) => {
  const state = fixture.states[tick];
  if (!state) throw new Error("Missing pickup test boundary");
  return structuredClone(state);
};

describe("authoritative pickup room transactions and recovery", () => {
  it("shares all five finite families while firing, despite duplicate packets and arbitrary arrival order", () => {
    const claims = fixture.states.flatMap((state) => state.combat.pickupClaims);
    expect(claims).toHaveLength(20);
    expect(fixture.duplicates).toBe(600);
    for (const sourceId of [500, 501, 502, 503, 504])
      expect(
        claims.filter((claim) => claim.sourceId === sourceId).map((claim) => claim.playerId),
      ).toEqual([4, 3, 2, 1]);
    for (const state of fixture.states) validateCombatCheckpoint(state);
    expect(fixture.state.combat.players.map((p) => [p.weapon.id, p.lives])).toEqual(
      Array(4).fill(["laser", 3]),
    );
    expect(fixture.state.combat.pickups.items.find((item) => item.id === 621)).toMatchObject({
      status: "expired",
      resolvedTick: 24,
      claimedBy: null,
    });
  });
  it("restores exact private latches and public availability through archives and journals", {
    timeout: 20000,
  }, async () => {
    const proof = await pickupCombatProof();
    expect(proof.checkpoints.map((checkpoint) => checkpoint.tick)).toEqual(
      PICKUP_COMBAT_BOUNDARIES,
    );
    expect(proof.checkpoints.some((checkpoint) => checkpoint.contacts.length > 0)).toBe(true);
    const state = stateAt(6),
      context = combatPeerContext(state.snapshot, 0);
    const decoded = decodeSnapshot(encodeSnapshot(state.snapshot, context), context);
    expect(decoded).toEqual(state.snapshot);
    expect(decoded.combat?.pickups).toEqual(state.combat.pickups.items);
    expect(decoded.combat).not.toHaveProperty("contacts");
  });
  it("retains confirmed claims through delayed delivery and suppresses every duplicate", () => {
    const state = stateAt(100),
      initial = stateAt(0),
      context = combatEventContext(state.snapshot);
    const receiver = new EventReceiver(context, initial.snapshot);
    const batches = eventBatches(state.history, 0, context.connectionEpoch);
    expect(batches).not.toBeNull();
    const received = [];
    for (const batch of batches ?? []) {
      const decoded = decodeEventBatch(encodeEventBatch(batch, context), context);
      received.push(...receiver.consume(decoded));
      expect(receiver.consume(decoded)).toEqual([]);
    }
    expect(received.filter((entry) => entry.event.kind === "pickup")).toHaveLength(20);
    expect(receiver.status.duplicates).toBe(received.length);
    expect(receiver.cursor).toBe(state.history.cursor);
  });
  it("encodes pickup payload words independently of the firearm and beam slots", () => {
    const state = stateAt(5),
      envelope = state.history.entries.find((entry) => entry.event.kind === "pickup");
    if (!envelope) throw new Error("Missing first claim");
    const context = combatEventContext(state.snapshot);
    const packet = {
      runEpoch: context.runEpoch,
      connectionEpoch: context.connectionEpoch,
      throughTick: 5,
      events: [envelope],
    };
    const bytes = encodeEventBatch(packet, context),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([76, 80, 84, 88, 92].map((offset) => view.getUint32(32 + offset, true))).toEqual([
      600, 2, 1, 0, 150,
    ]);
    expect(decodeEventBatch(bytes, context)).toEqual(packet);
  });
  it("rejects fabricated claim identity, grant amounts and firearm confirmation fields", () => {
    const state = stateAt(9),
      context = combatEventContext(state.snapshot);
    const original = state.history.entries.find((entry) => entry.event.kind === "pickup")?.event;
    if (!original) throw new Error("Missing pickup event");
    const mutations: Array<(event: GameplayEvent) => void> = [
      (event) => {
        event.actionInstanceId = 1;
      },
      (event) => {
        event.targetId = 999;
      },
      (event) => {
        event.ownerId = 0;
      },
      (event) => {
        event.definitionId++;
      },
      (event) => {
        event.x++;
      },
      (event) => {
        if (event.pickup) event.pickup.claimId++;
      },
      (event) => {
        if (event.pickup) event.pickup.ammo--;
      },
      (event) => {
        if (event.pickup) event.pickup.previousAmmo = 1;
      },
      (event) => {
        event.confirmation = { playerId: event.ownerId, controlEpoch: 1, shotOrdinal: 1 };
      },
    ];
    for (const change of mutations) {
      const event = structuredClone(original);
      change(event);
      expect(() => validateGameplayEvent(event, context)).toThrow();
    }
  });
  it("rejects a claimed item's resurrection and changed claimant in a later public snapshot", () => {
    const before = stateAt(9).snapshot,
      after = stateAt(12).snapshot;
    expect(() => validateCombatGeometryTransition(before, after)).not.toThrow();
    for (const status of ["available", "claimed"] as const) {
      const changed = structuredClone(after),
        item = changed.combat?.pickups[0];
      if (!item) throw new Error("Missing claimed supply");
      item.status = status;
      item.claimedBy = status === "claimed" ? 1 : null;
      expect(() => validateCombatGeometryTransition(before, changed)).toThrow(/Pickup history/);
    }
  });
  it("rejects changed private latch geometry, pickup boundary and terminal grant inventory", () => {
    const mutations: Array<(state: CombatRuntime) => void> = [
      (state) => {
        state.combat.pickups.tick++;
      },
      (state) => {
        required(state.combat.pickups.contacts[0]).playerId = 1;
      },
      (state) => {
        required(state.combat.pickupClaims[0]).ammo--;
      },
      (state) => {
        state.combat.pickupClaims = [];
      },
    ];
    for (const mutate of mutations) {
      const changed = stateAt(5);
      mutate(changed);
      expect(() => validateCombatCheckpoint(changed)).toThrow();
    }
  });
  it("preserves contact latches and inventory across recovery without granting a second item", () => {
    const original = stateAt(5),
      recovered = transitionCombatRuntime(original, "recover");
    validateCombatCheckpoint(recovered);
    expect(recovered.combat.pickups).toEqual(original.combat.pickups);
    expect(recovered.combat.players.map((p) => p.weapon)).toEqual(
      original.combat.players.map((p) => p.weapon),
    );
    expect(recovered.history.entries).toEqual([]);
    const resumed = stageCombatRuntime(transitionCombatRuntime(recovered, "start"), []);
    validateCombatCheckpoint(resumed.state);
    expect(resumed.state.combat.pickupClaims.some((claim) => claim.playerId === 4)).toBe(false);
  });
  it("leaves every queue, acknowledgment, claim and inventory unchanged when publication aborts", () => {
    const initial = createCombatRuntime("pickups");
    for (const actor of initial.combat.players) actor.body.x = pixels(90);
    initial.snapshot = combatSnapshot(initial.combat, initial.snapshot, initial.campaign);
    const before = canonical(initial);
    const streams = initial.combat.players.map((actor) => {
      const context = combatPeerContext(initial.snapshot, actor.slot);
      const stream = new InputStream({ ...context, controlEpoch: 1, baselineServerTick: 0 });
      stream.receive(
        encodeInputBatch({
          ...context,
          packetSequence: 1,
          snapshotAck: 0,
          eventAck: 0,
          commands: [
            { sequence: 1, clientTick: 0, controlEpoch: 1, held: Held.Up, aim: 0, edges: [] },
          ],
        }),
        0,
        0,
      );
      return stream;
    });
    expect(() =>
      InputStream.processWorldTick(streams, 1, 16, (prepared) => {
        const candidate = stageCombatRuntime(initial, prepared);
        expect(candidate.state.combat.pickupClaims).toHaveLength(4);
        throw new Error("Injected pickup publication failure");
      }),
    ).toThrow(/publication failure/);
    expect(canonical(initial)).toBe(before);
    expect(
      streams.every(
        (stream) =>
          stream.acknowledgment.lastProcessedSequence === 0 &&
          stream.queuedCommands === 1 &&
          stream.requiresResync,
      ),
    ).toBe(true);
  });
  it("retires a supply when accepted attacks destroy its support and preserves that result", () => {
    const proof = recordSupport();
    const before = proof.states[34],
      after = proof.states[35];
    if (!before || !after) throw new Error("Missing support boundary");
    expect(before.combat.pickups.items[0]?.status).toBe("available");
    expect(after.combat.pickups.items[0]).toMatchObject({
      status: "unsupported",
      resolvedTick: 35,
      claimedBy: null,
    });
    validateCombatCheckpoint(after);
    expect(after.snapshot.removedIds).toContain(620);
    expect(after.combat.pickupClaims).toEqual([]);
  });
  it("does not consume full matching inventory until a player leaves and re-enters", () => {
    let world = createCombatLab("pickups");
    const actor = world.players[0];
    if (!actor) throw new Error("Missing player");
    actor.body.x = pixels(90);
    actor.weapon = { ...actor.weapon, id: "heavy-machine-gun", ammo: 150 };
    world = stepCombatLab(world, [idle]);
    expect(world.pickupClaims).toEqual([]);
    required(world.players[0]).weapon.ammo = 149;
    world = stepCombatLab(world, [idle]);
    expect(world.pickupClaims).toEqual([]);
    required(world.players[0]).body.x = pixels(60);
    world = stepCombatLab(world, [idle]);
    required(world.players[0]).body.x = pixels(90);
    world = stepCombatLab(world, [idle]);
    expect(world.pickupClaims).toHaveLength(1);
    expect(world.pickupClaims[0]).toMatchObject({ previousAmmo: 149, ammo: 150 });
  });
  it("restarts checkpoint supplies only after a paid continue, preserving expired supply lifetime", () => {
    const initial = transitionCombatRuntime(
      transitionCombatRuntime(stateAt(100), "recover"),
      "start",
    );
    for (const actor of initial.combat.players) {
      actor.lives = 1;
      actor.body.x = pixels(420);
      actor.body.y = pixels(100);
      actor.body.grounded = false;
      actor.body.supportId = null;
      actor.body.contacts = [];
      actor.locomotion = "airborne";
    }
    initial.snapshot = combatSnapshot(initial.combat, initial.snapshot, initial.campaign);
    const wipe = recordCombatInputs(initial, 90, 0).state;
    expect(wipe.snapshot.roomMode).toBe("intermission");
    expect(
      wipe.combat.players.every((player) => player.life === "spectating" && player.lives === 0),
    ).toBe(true);
    const continued = transitionCombatRuntime(wipe, "continue");
    validateCombatCheckpoint(continued);
    expect(continued.snapshot.runEpoch).toBe(wipe.snapshot.runEpoch + 1);
    expect(continued.campaign.state.continuesUsed).toBe(1);
    expect(
      continued.combat.pickups.items.filter((item) => item.status === "available"),
    ).toHaveLength(20);
    expect(continued.combat.pickups.items.find((item) => item.id === 621)).toMatchObject({
      status: "expired",
      resolvedTick: 24,
    });
    expect(continued.combat.pickups.contacts).toEqual([]);
    expect(continued.combat.pickupClaims).toEqual([]);
    expect(
      continued.combat.players.every(
        (player) => player.weapon.id === "sidearm" && player.lives === 3,
      ),
    ).toBe(true);
  });
});
