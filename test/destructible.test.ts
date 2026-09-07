import { beforeAll, describe, expect, it } from "vitest";
import { createDestructible, destructibleHurtboxes } from "../src/game/combat/destructible.js";
import {
  type BallisticProjectile,
  type HurtTarget,
  sweepProjectile,
} from "../src/game/combat/projectile.js";
import { explosionHits, rectangularHits } from "../src/game/combat/volume.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_ATTACKS, COMBAT_SHAPES } from "../src/game/labs/combat-content.js";
import { COMBAT_SUPPORT } from "../src/game/labs/combat-terrain.js";
import { encodeCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import {
  combatPeerContext,
  predictCombatMovement,
  validateCombatGeometryTransition,
} from "../src/shared/diagnostics/combat-workload.js";
import { renewControllerGenerations } from "../src/shared/diagnostics/controller-recovery.js";
import { ControllerPrediction } from "../src/shared/prediction/controller.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";
import { recordSupport, supportProof } from "./fixtures/support-proof.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing authored fixture value");
  return value;
}
let fixture: ReturnType<typeof recordSupport>;
beforeAll(() => {
  fixture = recordSupport();
});
describe("attack-driven support destruction", () => {
  it("retains partial damage and resolves two genuine falls exactly once without fabricated kill credit", () => {
    expect(fixture.duplicates).toBe(480);
    expect(
      fixture.states.every((state) =>
        state.combat.targets.every((target) => !Object.is(target.enemy.body.vx, -0)),
      ),
    ).toBe(true);
    expect(fixture.states[11]?.combat.props[0]?.health).toBe(4);
    const boundary = fixture.states[35];
    expect(boundary?.snapshot.geometryRevision).toBe(2);
    expect(boundary?.combat.props[0]).toMatchObject({
      health: 0,
      destroyedTick: 35,
      destroyerId: 1,
      destroyActionId: 7,
    });
    for (const target of boundary?.combat.targets ?? [])
      expect(target.enemy.body).toMatchObject({
        grounded: false,
        supportId: null,
        y: pixels(160),
        vy: 0,
      });
    for (const target of fixture.states[36]?.combat.targets ?? [])
      expect(target.enemy.body).toMatchObject({ grounded: false, y: pixels(160) + 55, vy: 55 });
    expect(fixture.states[58]?.combat.encounter.phase).toBe("active");
    expect(fixture.states[59]?.combat.encounter.phase).toBe("complete");
    expect(
      fixture.state.combat.encounter.members.every(
        (member) =>
          member.reason === "out-of-bounds" &&
          member.killerId === null &&
          member.resolvedTick === 59,
      ),
    ).toBe(true);
    expect(fixture.state.combat.encounter.kills.every((kill) => kill.count === 0)).toBe(true);
    expect(fixture.state.combat.encounter.receipts).toHaveLength(4);
    expect(fixture.state.snapshot.removedIds).toEqual([20, 21, 104]);
    expect(fixture.state.snapshot.campaign.remainingEnemies).toBe(0);
    expect(
      fixture.states
        .flatMap((state) => state.combat.events)
        .filter((event) => event.kind === "prop-destroyed"),
    ).toHaveLength(1);
    expect(
      fixture.state.combat.players.every(
        (player) => player.lives === 3 && player.weapon.shotOrdinal === 2,
      ),
    ).toBe(true);
  });
  it("restores partial damage, accepted geometry, falling bodies and terminal ledgers through checkpoints and applied-input journals", async () => {
    const proof = await supportProof();
    expect(proof.checkpoints.map((checkpoint) => checkpoint.geometryRevision)).toEqual([
      1, 1, 1, 1, 2, 2, 2, 2, 2, 2,
    ]);
    expect(proof.checkpoints.at(-1)?.encounter.phase).toBe("complete");
  });
  it("rejects unknown or inconsistent geometry and destruction ownership before exposing a restored world", async () => {
    const identity = await combatArchiveIdentity();
    for (const change of [
      (state: typeof fixture.state) => {
        if (state.combat.props[0]) state.combat.props[0].destroyerId = 999;
      },
      (state: typeof fixture.state) => {
        if (state.combat.props[0]) state.combat.props[0].definitionId = 2;
      },
      (state: typeof fixture.state) => {
        if (state.combat.props[0]) state.combat.props[0].health = 1;
      },
      (state: typeof fixture.state) => {
        state.snapshot.geometryRevision = 3;
      },
    ]) {
      const state = structuredClone(fixture.state);
      change(state);
      await expect(encodeCombatCheckpoint(state, identity)).rejects.toThrow();
    }
    const snapshot = fixture.state.snapshot,
      context = combatPeerContext(snapshot, 0);
    const bytes = encodeSnapshot(snapshot, context);
    expect(() =>
      decodeSnapshot(bytes, { ...context, geometryRevision: 1, geometryRevisions: undefined }),
    ).toThrow(/geometry/);
    const damaged = structuredClone(snapshot);
    if (damaged.combat?.props[0]) damaged.combat.props[0].definitionId = 2;
    expect(() => encodeSnapshot(damaged, context)).toThrow(/definition/);
  });
  it("replays retained commands only after the corresponding geometry has been loaded", () => {
    const before = required(fixture.states[34]),
      after = required(fixture.states[35]);
    let loaded = before;
    const fresh = renewControllerGenerations(before.snapshot);
    const actor = required(fresh.players[0]),
      acknowledgment = required(fresh.acknowledgments[0]);
    const baseline = {
      runEpoch: fresh.runEpoch,
      connectionEpoch: acknowledgment.connectionEpoch,
      tick: 34,
      actor,
      acknowledgment,
    };
    const prediction = new ControllerPrediction(
      baseline,
      (a, command, tick) => predictCombatMovement(a, command, tick, "support", loaded.combat.props),
      undefined,
      () => loaded.snapshot.geometryRevision,
    );
    const first = {
      sequence: 1,
      clientTick: 0,
      controlEpoch: actor.controlEpoch,
      held: 0,
      aim: 0 as const,
      edges: [],
    };
    const pending = { ...first, sequence: 2, clientTick: 1 };
    prediction.submit(first);
    prediction.submit(pending);
    const restoredActor = structuredClone(required(after.snapshot.players[0]));
    restoredActor.controlEpoch = actor.controlEpoch;
    restoredActor.processedEdgeIds = [0, 0, 0, 0, 0];
    const restored = {
      ...baseline,
      tick: 35,
      actor: restoredActor,
      acknowledgment: { ...acknowledgment, lastProcessedSequence: 1, appliedAtServerTick: 35 },
    };
    // A separate predictor cannot accept the changed revision while its loaded geometry is old.
    const unavailable = new ControllerPrediction(baseline, (a, command, tick) =>
      predictCombatMovement(a, command, tick, "support", before.combat.props),
    );
    unavailable.submit(first);
    unavailable.submit(pending);
    expect(() => unavailable.reconcile(restored)).toThrow(/identity/);
    loaded = after;
    prediction.reconcile(restored);
    expect(prediction.pending).toBe(1);
    expect(prediction.tick).toBe(36);
    expect(prediction.actor.geometryRevision).toBe(2);
    expect(pending).toEqual({ ...first, sequence: 2, clientTick: 1 });
  });
  it("rejects revived props, changed destruction attribution and removed definitions within the same run", () => {
    const before = required(fixture.states[34]).snapshot,
      after = required(fixture.states[35]).snapshot;
    expect(() => validateCombatGeometryTransition(before, after)).not.toThrow();
    for (const change of [
      (snapshot: typeof before) => {
        if (snapshot.combat?.props[0]) snapshot.combat.props[0].health = 8;
      },
      (snapshot: typeof before) => {
        if (snapshot.combat?.props[0]) snapshot.combat.props[0].destroyActionId = 8;
      },
      (snapshot: typeof before) => {
        if (snapshot.combat) snapshot.combat.props = [];
      },
    ]) {
      const next = structuredClone(after);
      change(next);
      expect(() => validateCombatGeometryTransition(after, next)).toThrow();
    }
  });
  it("selects the real knife action near a prop and applies its bounded active window once", () => {
    let world = createCombatLab("support", 1);
    const hits = [];
    for (let tick = 1; tick <= 60; tick++) {
      world = stepCombatLab(world, [
        {
          held: tick <= 40 ? Held.Right : 0,
          jumpPressed: false,
          firePressed: tick === 41,
          grenadePressed: false,
          interactPressed: false,
        },
      ]);
      if (tick === 41) expect(world.players[0]?.action.kind).toBe("melee");
      hits.push(
        ...world.events.filter((event) => event.kind === "impact" && event.targetId === 104),
      );
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]?.impact?.definitionId).toBe(4);
    expect(world.props[0]?.health).toBe(7);
  });
  it("makes a neutral damageable solid win projectile and volume queries while shielding an actor behind it", () => {
    const definition = {
      ...required(COMBAT_SUPPORT[0]),
      rect: { x: pixels(100), y: pixels(160), w: pixels(8), h: pixels(32) },
    };
    const prop = createDestructible(definition);
    const behind: HurtTarget = {
      id: 201,
      entityId: 20,
      team: 0,
      kind: "body",
      rect: { x: pixels(120), y: pixels(160), w: pixels(8), h: pixels(32) },
      delta: { x: 0, y: 0 },
    };
    const targets = [...destructibleHurtboxes([prop], [definition]), behind];
    const projectile: BallisticProjectile = {
      id: 1000,
      ownerId: 1,
      team: 1,
      actionInstanceId: 1,
      definitionId: 1,
      spawnTick: 1,
      position: { x: pixels(70), y: pixels(177) },
      velocity: { x: pixels(64), y: 0 },
    };
    expect(
      sweepProjectile(
        projectile,
        required(COMBAT_ATTACKS.get(1)),
        required(COMBAT_SHAPES.get(4)),
        [],
        targets,
      ),
    ).toMatchObject({ entityId: 104, damage: 1 });
    expect(
      sweepProjectile(
        { ...projectile, ownerId: 21, team: 2 },
        required(COMBAT_ATTACKS.get(1)),
        required(COMBAT_SHAPES.get(4)),
        [],
        targets,
      ),
    ).toMatchObject({ entityId: 104 });
    const volume = { x: pixels(80), y: pixels(160), w: pixels(60), h: pixels(32) };
    expect(
      rectangularHits(
        { ...projectile, definitionId: 10 },
        required(COMBAT_ATTACKS.get(10)),
        volume,
        { x: 0, y: 0 },
        projectile.position,
        [],
        targets,
      ).map((hit) => hit.entityId),
    ).toEqual([104]);
    expect(
      explosionHits(
        { ...projectile, definitionId: 5 },
        required(COMBAT_ATTACKS.get(5)),
        projectile.position,
        pixels(64),
        [],
        targets,
      ).map((hit) => hit.entityId),
    ).toEqual([104]);
    expect(
      sweepProjectile(
        projectile,
        required(COMBAT_ATTACKS.get(1)),
        required(COMBAT_SHAPES.get(4)),
        [],
        [behind],
      ),
    ).toMatchObject({ entityId: 20 });
  });
});
