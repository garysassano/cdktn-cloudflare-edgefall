import { describe, expect, it } from "vitest";
import { damagePlayer } from "../src/game/campaign/life.js";
import { MATERIAL_CASES, materialScenario } from "../src/game/content/scenarios/materials.js";
import { Edge, Held, type InputCommand } from "../src/game/input/types.js";
import { createCombatLab } from "../src/game/labs/combat.js";
import {
  predictCombatController,
  predictedFirearmCues,
} from "../src/shared/diagnostics/combat-prediction.js";
import { combatSnapshot } from "../src/shared/diagnostics/combat-workload.js";
import {
  ControllerPrediction,
  type PredictionBaseline,
} from "../src/shared/prediction/controller.js";
import {
  FIREARM_FEEDBACK_MS,
  FirearmFeedback,
  type PredictedFirearmCue,
} from "../src/shared/prediction/firearm-feedback.js";
import type { EventEnvelope } from "../src/shared/protocol/events.js";
import { firearmFeedbackProof } from "./fixtures/firearm-feedback-proof.js";

const cue: PredictedFirearmCue = {
  sequence: 1,
  tick: 1,
  confirmation: { playerId: 1, controlEpoch: 1, shotOrdinal: 1 },
  markerIndex: 0,
  definitionId: 1,
  x: 123,
  y: 456,
};
const event: EventEnvelope = {
  cursor: 1,
  tick: 1,
  counter: 0,
  event: {
    kind: "shot",
    origin: "player",
    ownerId: 1,
    actionInstanceId: 42,
    markerIndex: 0,
    definitionId: 1,
    x: cue.x,
    y: cue.y,
    targetId: null,
    material: "none",
    confirmation: cue.confirmation,
    beam: null,
    pickup: null,
  },
};
const boundary = { tick: 0, acknowledgedSequence: 0, eventCursor: 0 };
const accepted = { tick: 1, acknowledgedSequence: 1, eventCursor: 1 };

describe("local firearm feedback", () => {
  it("matches six real weapon kernels in solo and four-player movement without mutating authority", () => {
    const proof = firearmFeedbackProof();
    expect(proof).toHaveLength(24);
    expect(proof.every((p) => p.markers > 0)).toBe(true);
  });
  it("prepares input in all 64 material scenes without counting damageable cover twice", () => {
    for (const definition of MATERIAL_CASES) {
      const snapshot = combatSnapshot(createCombatLab(materialScenario(definition), 4));
      for (const actor of snapshot.players)
        expect(() =>
          predictCombatController(
            actor,
            { sequence: 1, clientTick: 0, controlEpoch: 1, held: 0, aim: 0, edges: [] },
            1,
            snapshot,
          ),
        ).not.toThrow();
    }
  });
  it("shows a flash before acknowledgment, promotes corrected geometry and does not restart its age", () => {
    const feedback = new FirearmFeedback(1, 1);
    feedback.synchronize([cue], boundary, 0, 10);
    const flash = feedback.visible(11)[0];
    expect(flash?.state).toBe("predicted");
    feedback.presented([flash?.id ?? ""], 11);
    feedback.synchronize([], accepted, 0, 20);
    expect(feedback.status.items[0]?.state).toBe("predicted");
    feedback.confirm(
      { ...event, event: { ...event.event, x: 789, kind: "muzzle-blocked", material: "terrain" } },
      30,
    );
    feedback.confirm(event, 31);
    feedback.synchronize([], accepted, 1, 32);
    expect(feedback.status).toMatchObject({ predicted: 1, presented: 1, promoted: 1, rejected: 0 });
    expect(feedback.visible(33)[0]).toMatchObject({
      state: "confirmed",
      kind: "muzzle-blocked",
      x: 789,
      bornAtMs: 10,
      acknowledgedAtMs: 20,
    });
    expect(feedback.visible(10 + FIREARM_FEEDBACK_MS)).toEqual([]);
  });
  it("does not revive an already rendered flash after a dropped event frame", () => {
    const feedback = new FirearmFeedback(1, 1);
    feedback.synchronize([cue], boundary, 0, 0);
    feedback.presented(
      feedback.visible(1).map((i) => i.id),
      1,
    );
    feedback.synchronize([], accepted, 0, 200);
    feedback.confirm(event, 250);
    expect(feedback.visible(250)).toEqual([]);
    expect(feedback.status.promoted).toBe(1);
  });
  it("gives an unseen authoritative shot one exposure and deduplicates it", () => {
    const feedback = new FirearmFeedback(1, 1);
    feedback.confirm(event, 20);
    feedback.presented(
      feedback.visible(21).map((i) => i.id),
      21,
    );
    feedback.confirm(event, 200);
    expect(feedback.visible(200)).toEqual([]);
    expect(feedback.status).toMatchObject({ authoritative: 1, presented: 1 });
    expect(
      feedback.confirm(
        { ...event, event: { ...event.event, kind: "impact", confirmation: null } },
        210,
      ),
    ).toBe(false);
    expect(new FirearmFeedback(1, 2).confirm(event, 210)).toBe(false);
  });
  it("rejects only after the complete paired event prefix and permits a later ungranted ordinal", () => {
    const feedback = new FirearmFeedback(1, 1);
    feedback.synchronize([cue], boundary, 0, 0);
    feedback.synchronize([], accepted, 0, 10);
    expect(feedback.status.rejected).toBe(0);
    feedback.synchronize([], accepted, 1, 20);
    expect(feedback.visible(20)).toEqual([]);
    feedback.synchronize([{ ...cue, tick: 2, sequence: 2 }], accepted, 1, 30);
    expect(feedback.visible(30)[0]).toMatchObject({ tick: 2, sequence: 2, bornAtMs: 30 });
    expect(feedback.status).toMatchObject({ predicted: 2, rejected: 1 });
  });
  it("replays pending controllers without duplicate callbacks and rejects their shots after authoritative death", () => {
    const snapshot = combatSnapshot(createCombatLab("range")),
      actor = snapshot.players[0],
      acknowledgment = snapshot.acknowledgments[0];
    if (!actor || !acknowledgment) throw new Error("Missing actor");
    const baseline: PredictionBaseline = {
      runEpoch: 1,
      connectionEpoch: 1,
      tick: 0,
      actor,
      acknowledgment,
    };
    const prediction = new ControllerPrediction(baseline, (a, c, t) =>
      predictCombatController(a, c, t, snapshot),
    );
    const feedback = new FirearmFeedback(1, actor.playerId);
    for (let sequence = 1; sequence <= 6; sequence++) {
      const command: InputCommand = {
        sequence,
        clientTick: sequence - 1,
        controlEpoch: 1,
        held: Held.Fire | Held.Right | Held.Up,
        aim: 1,
        edges: [],
      };
      prediction.submit(command);
      feedback.synchronize(predictedFirearmCues(prediction.frames), boundary, 0, sequence);
    }
    expect(feedback.status.predicted).toBe(1);
    prediction.reconcile(baseline);
    feedback.synchronize(predictedFirearmCues(prediction.frames), boundary, 0, 10);
    expect(feedback.status.predicted).toBe(1);
    const died = structuredClone(baseline);
    died.actor = damagePlayer(actor, 0, 1, "classic", "fall").actor;
    prediction.reconcile(died);
    feedback.synchronize(predictedFirearmCues(prediction.frames), boundary, 0, 20);
    expect(prediction.actor.life).toBe("death");
    expect(feedback.status.rejected).toBe(1);
    expect(feedback.visible(20)).toEqual([]);
  });
  it("resets cosmetic state on baseline repair without replaying pending flashes", () => {
    const feedback = new FirearmFeedback(1, 1);
    const pending = { ...cue, sequence: 6, tick: 6 };
    feedback.synchronize([pending], boundary, 0, 0);
    feedback.reset(3);
    feedback.synchronize([pending], { ...boundary, tick: 3 }, 0, 10);
    expect(feedback.visible(10)).toEqual([]);
    expect(feedback.status.predicted).toBe(1);
    expect(new FirearmFeedback(2, 1).visible(10)).toEqual([]);
  });
  it("shares empty fallback and grenade priority without inventing gun markers", () => {
    const snapshot = combatSnapshot(createCombatLab("laser")),
      actor = snapshot.players[0];
    if (!actor) throw new Error("Missing actor");
    actor.weapon.ammo = 0;
    const command: InputCommand = {
      sequence: 1,
      clientTick: 0,
      controlEpoch: 1,
      held: Held.Fire | Held.Up,
      aim: 1,
      edges: [{ kind: Edge.FireOnset, id: 1 }],
    };
    const fallback = predictCombatController(actor, command, 1, snapshot);
    expect(fallback.weapon.id).toBe("sidearm");
    expect(predictedFirearmCues([{ sequence: 1, tick: 1, actor: fallback }])).toHaveLength(1);
    command.edges.push({ kind: Edge.Grenade, id: 1 });
    const grenade = predictCombatController(actor, command, 1, snapshot);
    expect(grenade.action.kind).toBe("grenade");
    expect(predictedFirearmCues([{ sequence: 1, tick: 1, actor: grenade }])).toEqual([]);
    expect(actor.grenadeStock).toBe(10);
  });
});
