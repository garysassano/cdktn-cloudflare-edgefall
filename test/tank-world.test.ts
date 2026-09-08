import { beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Edge, Held } from "../src/game/input/types.js";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { TANK_PROFILE } from "../src/game/labs/combat-content.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import {
  replaceWaitingCombatConnection,
  transitionCombatRuntime,
} from "../src/shared/diagnostics/combat-recovery.js";
import {
  type CombatRuntime,
  replayCombatTick,
  stageCombatRuntime,
} from "../src/shared/diagnostics/combat-runtime.js";
import { combatPeerContext } from "../src/shared/diagnostics/combat-workload.js";
import { InputStream } from "../src/shared/protocol/input-stream.js";
import { recordTankCombat, tankCombatProof } from "./fixtures/tank-proof.js";
import { specialInput } from "./fixtures/tank-special-proof.js";

const idle = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  specialPressed: false,
  interactPressed: false,
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing tank fixture boundary");
  return value;
}
let fixture: ReturnType<typeof recordTankCombat>;
let arming: ReturnType<typeof recordTankCombat>;
beforeAll(() => {
  fixture = recordTankCombat();
  arming = recordTankCombat(13, specialInput);
});
describe("authoritative tank laboratory", () => {
  it("keeps each depot tank reachable when four claims arrive in reverse slot order", () => {
    let world = createCombatLab("tank", 4);
    for (let tick = 1; tick <= 4; tick++)
      world = stepCombatLab(
        world,
        world.players.map((player) => ({ ...idle, interactPressed: player.slot === 4 - tick })),
      );
    expect(world.tanks.map((tank) => tank.reservedBy)).toEqual([1, 2, 3, 4]);
    expect(world.players.map((player) => player.vehicleId)).toEqual([30, 31, 32, 33]);
  });
  it("boards four owners, drives and jumps on shared terrain, kills actual enemies and exits without spending lives", () => {
    expect(required(fixture.states[1]).combat.tanks.map((tank) => tank.reservedBy)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      required(fixture.states[11]).combat.tanks.every((tank) => tank.lifecycle === "boarding"),
    ).toBe(true);
    expect(required(fixture.states[12]).combat.tanks.map((tank) => tank.occupantId)).toEqual([
      1, 2, 3, 4,
    ]);
    const jumping = required(fixture.states[21]);
    expect(
      jumping.combat.tanks.every(
        (tank) => !tank.body.grounded && tank.body.y < pixels(200) && tank.heading > 0,
      ),
    ).toBe(true);
    expect(
      fixture.state.combat.tanks.map((tank) => [tank.body.x / 256, tank.body.y / 256]),
    ).toEqual([
      [102, 200],
      [158, 200],
      [214, 200],
      [270, 200],
    ]);
    expect(
      fixture.state.combat.tanks.every(
        (tank) =>
          tank.lifecycle === "available" && tank.weapon.shotOrdinal === 3 && tank.weapon.ammo === 0,
      ),
    ).toBe(true);
    expect(
      fixture.state.combat.players.every(
        (player) => player.lives === 3 && player.vehicleId === null && player.controlEpoch === 5,
      ),
    ).toBe(true);
    expect(fixture.state.combat.encounter.phase).toBe("complete");
    expect(fixture.duplicates).toBe(480);
    expect(
      fixture.entries.flatMap((entry) =>
        entry.boundaryEvents.filter(({ event }) => event.kind === "seat"),
      ).length,
    ).toBe(16);
  });

  it("resolves an equal-tick scarce-seat claim by player slot without a second allocation or attachment", () => {
    const world = createCombatLab("tank", 4);
    for (const player of world.players) player.body.x = pixels(30);
    const next = stepCombatLab(
      world,
      world.players.map(() => ({ ...idle, interactPressed: true })),
    );
    expect(next.players.map((player) => player.vehicleId)).toEqual([30, null, null, null]);
    expect(next.tanks.filter((tank) => tank.reservedBy !== null)).toHaveLength(1);
    expect(world.players.every((player) => player.vehicleId === null)).toBe(true);
  });

  it("rejects delayed boarding-era fire and jump at the driver baseline, then accepts fresh-owner intent", () => {
    const run = recordTankCombat(14, (tick) => ({
      held: tick >= 13 ? Held.Fire | Held.Right : 0,
      ...(tick === 13 ? { controlEpoch: 2 } : {}),
      edges:
        tick === 1
          ? [Edge.Interact]
          : tick === 13
            ? [Edge.Jump, Edge.FireOnset]
            : tick === 14
              ? [Edge.FireOnset]
              : [],
    }));
    const old = required(run.entries[12]);
    expect(
      old.inputs.every(
        ({ input, edgeResults }) =>
          input.outcome === "old-control" &&
          edgeResults.every((edge) => edge.outcome === "old-control"),
      ),
    ).toBe(true);
    expect(
      required(run.states[13]).combat.tanks.every(
        (tank) => tank.weapon.shotOrdinal === 0 && tank.body.grounded,
      ),
    ).toBe(true);
    expect(run.state.combat.tanks.every((tank) => tank.weapon.shotOrdinal === 1)).toBe(true);
    expect(
      run.state.snapshot.acknowledgments.every(
        (ack) => ack.controlEpoch === 3 && ack.lastProcessedSequence === 14,
      ),
    ).toBe(true);
  });

  it("uses one armor debit per protection window, then ejects before a later exposed-body death", () => {
    const run = recordTankCombat(196, (tick) => ({
      held: 0,
      edges: tick === 1 ? [Edge.Interact] : [],
    }));
    const hits: number[] = [];
    for (let tick = 1; tick < run.states.length; tick++) {
      if (
        required(run.states[tick]).combat.tanks[3]?.armor !==
        required(run.states[tick - 1]).combat.tanks[3]?.armor
      )
        hits.push(tick);
    }
    expect(hits).toHaveLength(3);
    expect(
      hits
        .slice(1)
        .every((tick, i) => tick - required(hits[i]) >= TANK_PROFILE.damageProtectionTicks),
    ).toBe(true);
    const ejected = required(run.states[183]);
    expect(ejected.combat.tanks[3]).toMatchObject({
      armor: 0,
      lifecycle: "wreck",
      occupantId: null,
      reservedBy: null,
      ownerControlEpoch: null,
    });
    expect(ejected.combat.players[3]).toMatchObject({
      vehicleId: null,
      life: "alive",
      lives: 3,
      controlEpoch: 4,
      invulnerableTicks: 12,
    });
    expect(required(run.states[195]).combat.players[3]).toMatchObject({
      vehicleId: null,
      life: "death",
      lives: 2,
    });
    expect(required(run.states[196]).combat.tanks[3]).toEqual(ejected.combat.tanks[3]);
  });

  it("releases disconnected owners at the finite grace boundary and journals the derived handoff", () => {
    let state = structuredClone(required(fixture.states[12]));
    for (let elapsed = 1; elapsed <= 15; elapsed++) {
      const candidate = stageCombatRuntime(state, []);
      expect(replayCombatTick(state, candidate.journal)).toEqual(candidate.state);
      state = candidate.state;
      validateCombatCheckpoint(state);
      expect(
        state.combat.tanks.every(
          (tank) => tank.lifecycle === (elapsed < 15 ? "occupied" : "available"),
        ),
      ).toBe(true);
      if (elapsed === 15)
        expect(
          candidate.journal.boundaryEvents.every(
            ({ event }) => event.kind === "seat" && event.reason === "disconnect",
          ),
        ).toBe(true);
    }
    expect(
      state.combat.players.every(
        (player) => player.controlEpoch === 4 && player.vehicleId === null,
      ),
    ).toBe(true);
  });

  it("settles seats without ticking on empty pause and before renewing recovery generations", () => {
    const before = required(fixture.states[12]),
      saved = canonical(before);
    const paused = transitionCombatRuntime(before, "pause");
    validateCombatCheckpoint(paused);
    expect(paused.combat.tick).toBe(12);
    expect(paused.combat.tanks.every((tank) => tank.lifecycle === "available")).toBe(true);
    expect(
      paused.combat.players.every(
        (player) => player.controlEpoch === 4 && player.vehicleId === null,
      ),
    ).toBe(true);
    for (const source of [before, paused]) {
      const recovered = transitionCombatRuntime(source, "recover");
      validateCombatCheckpoint(recovered);
      expect(recovered.snapshot.runEpoch).toBe(2);
      expect(recovered.combat.tick).toBe(12);
      expect(recovered.combat.players.every((player) => player.vehicleId === null)).toBe(true);
    }
    expect(canonical(before)).toBe(saved);
  });

  it.each([
    { phase: "boarding", tick: 1 },
    { phase: "final boarding tick", tick: 11 },
    { phase: "occupied", tick: 12 },
    { phase: "arming", tick: 13 },
    { phase: "exiting", tick: 90 },
    { phase: "final exit tick", tick: 96 },
  ])(
    "replaces a waiting or playing $phase connection with a fresh unseated baseline",
    ({ tick, phase }) => {
      const playing = required((phase === "arming" ? arming : fixture).states[tick]);
      const saved = canonical(playing);
      const expectedEpoch = required(playing.combat.players[0]).controlEpoch + 1;
      const before = structuredClone(playing);
      before.snapshot.roomMode = "loading";
      const waiting = replaceWaitingCombatConnection(before, 1);
      validateCombatCheckpoint(waiting);
      expect(waiting.combat.players[0]).toMatchObject({
        vehicleId: null,
        controlEpoch: expectedEpoch,
        lives: 3,
      });
      expect(waiting.combat.tanks.slice(1)).toEqual(before.combat.tanks.slice(1));
      const ack = required(playing.snapshot.acknowledgments[0]);
      const stream = new InputStream({
        ...combatPeerContext(playing.snapshot, 0),
        connectionEpoch: ack.connectionEpoch + 1,
        controlEpoch: ack.controlEpoch,
        baselineServerTick: tick,
      });
      const committed = InputStream.processWorldTick(
        [stream],
        tick + 1,
        (tick + 1) * 16,
        (prepared) => {
          const candidate = stageCombatRuntime(playing, prepared, [
            { playerId: 1, connectionEpoch: ack.connectionEpoch + 1 },
          ]);
          expect(replayCombatTick(playing, candidate.journal)).toEqual(candidate.state);
          return candidate;
        },
      );
      validateCombatCheckpoint(committed.state);
      expect(committed.state.combat.players[0]).toMatchObject({
        vehicleId: null,
        controlEpoch: expectedEpoch,
      });
      expect(stream.acknowledgment).toMatchObject({
        connectionEpoch: ack.connectionEpoch + 1,
        controlEpoch: expectedEpoch,
        lastProcessedSequence: 0,
      });
      for (const state of [waiting, committed.state]) {
        expect(state.combat.tanks[0]).toMatchObject({
          lifecycle: "available",
          occupantId: null,
          reservedBy: null,
          ownerControlEpoch: null,
          armor: playing.combat.tanks[0]?.armor,
          secondary: { ammo: playing.combat.tanks[0]?.secondary.ammo },
          special: { phase: phase === "arming" ? "canceled" : "ready" },
        });
      }
      expect(canonical(playing)).toBe(saved);
    },
  );

  it("restores entry, turret, gun and exit cursors through nine exact wire/archive boundaries", async () => {
    const proof = await tankCombatProof();
    expect(proof.checkpoints).toHaveLength(9);
    expect(proof.encounter).toBe("complete");
  });

  it("resolves real tank falls and a full-party wipe, then atomically replenishes the depot with new IDs", () => {
    const run = recordTankCombat(900, (tick) => ({
      held: Held.Right,
      edges: tick === 1 ? [Edge.Interact] : [],
    }));
    expect(run.state.combat.tick).toBe(539);
    expect(run.state.campaign.state.phase).toBe("wipe");
    const continued = transitionCombatRuntime(run.state, "continue");
    validateCombatCheckpoint(continued);
    expect(continued.campaign.state).toMatchObject({ continuesRemaining: 2, continuesUsed: 1 });
    expect(continued.combat.tanks.map((tank) => tank.body.id)).toEqual(
      [0, 1, 2, 3].map((slot) => run.state.combat.nextEntityId + 2 + slot),
    );
    expect(
      continued.combat.tanks.every((tank) => tank.armor === 3 && tank.lifecycle === "available"),
    ).toBe(true);
    expect(
      continued.combat.players.every((player) => player.vehicleId === null && player.lives === 3),
    ).toBe(true);
  });

  it("rejects malformed private vehicle motion, action ownership and public input linkage", () => {
    const mutate: Array<(state: CombatRuntime) => void> = [
      (state) => {
        required(state.combat.tanks[0]).heading = 8;
      },
      (state) => {
        required(state.combat.tanks[0]).lastGunOwnerId = 4;
      },
      (state) => {
        required(state.combat.tanks[0]).ownerControlEpoch = 1;
      },
      (state) => {
        required(state.combat.tanks[0]).body.x++;
      },
      (state) => {
        required(state.combat.projectiles.find((p) => p.definitionId === 16)).velocity.y++;
      },
    ];
    for (const change of mutate) {
      const state = structuredClone(required(fixture.states[60]));
      change(state);
      expect(() => validateCombatCheckpoint(state)).toThrow();
    }
  });
});
