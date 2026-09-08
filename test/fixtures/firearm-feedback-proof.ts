import {
  MATERIAL_LAB_WEAPONS,
  materialScenario,
} from "../../src/game/content/scenarios/materials.js";
import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held, type InputCommand } from "../../src/game/input/types.js";
import { type CombatScenario, createCombatLab, stepCombatLab } from "../../src/game/labs/combat.js";
import { combatGameplayEvents } from "../../src/shared/diagnostics/combat-events.js";
import {
  predictCombatController,
  predictedFirearmCues,
} from "../../src/shared/diagnostics/combat-prediction.js";
import { combatSnapshot } from "../../src/shared/diagnostics/combat-workload.js";
import { FirearmFeedback } from "../../src/shared/prediction/firearm-feedback.js";

/** Prediction never owns the authoritative world; compare its markers to actual kernel events. */
export function firearmFeedbackProof() {
  return (
    [
      "range",
      "hmg",
      "shotgun",
      "rocket",
      "flame",
      "laser",
      ...MATERIAL_LAB_WEAPONS.slice(0, 6).map((weapon) =>
        materialScenario({ weapon, materialId: "concrete", targetMotion: "stationary" }),
      ),
    ] as CombatScenario[]
  ).flatMap((scenario) =>
    [1, 4].map((players) => {
      let world = createCombatLab(scenario, players),
        cursor = 0,
        hash = "0",
        markers = 0;
      const feedback = world.players.map((p) => new FirearmFeedback(1, p.playerId));
      const movement = world.players.map(() => ({ run: false, jump: false }));
      for (let tick = 1; tick <= 90; tick++) {
        const held =
          Held.Fire |
          (tick < 21
            ? Held.Up
            : tick < 41
              ? Held.Right | Held.Down
              : tick < 61
                ? Held.Left
                : tick < 81
                  ? Held.Down
                  : Held.Up);
        const before = canonical(world),
          snapshot = combatSnapshot(world);
        const predictions = world.players.map((actor) => {
          const command: InputCommand = {
            sequence: tick,
            clientTick: tick - 1,
            controlEpoch: actor.controlEpoch,
            held,
            aim: 0,
            edges:
              tick === 1
                ? [{ kind: Edge.FireOnset, id: 1 }]
                : tick === 21
                  ? [{ kind: Edge.Jump, id: 1 }]
                  : [],
          };
          const predicted = predictCombatController(actor, command, tick, snapshot);
          return {
            actor: predicted,
            cues: predictedFirearmCues([{ sequence: tick, tick, actor: predicted }]),
          };
        });
        if (canonical(world) !== before) throw new Error("Prediction mutated authority");
        const next = stepCombatLab(
          world,
          world.players.map(() => ({
            held,
            firePressed: tick === 1,
            jumpPressed: tick === 21,
            grenadePressed: false,
            specialPressed: false,
            interactPressed: false,
          })),
        );
        const events = combatGameplayEvents(world, next).map((event, counter) => ({
          cursor: ++cursor,
          tick,
          counter,
          event,
        }));
        for (const [slot, prediction] of predictions.entries()) {
          const actual = next.players[slot],
            ledger = feedback[slot],
            coverage = movement[slot];
          if (!actual || !ledger || !coverage) throw new Error("Missing prediction owner");
          const cues = events
            .filter(
              (e) =>
                e.event.confirmation?.playerId === actual.playerId &&
                ["shot", "muzzle-blocked"].includes(e.event.kind),
            )
            .map(({ event }) => ({
              sequence: tick,
              tick,
              confirmation: event.confirmation,
              markerIndex: event.markerIndex,
              definitionId: event.definitionId,
              x: event.x,
              y: event.y,
            }));
          if (canonical(prediction.cues) !== canonical(cues))
            throw new Error(`Predicted marker mismatch ${scenario}/${players}/${tick}/${slot}`);
          if (
            prediction.actor.weapon.ammo !== actual.weapon.ammo ||
            prediction.actor.weapon.shotOrdinal !== actual.weapon.shotOrdinal ||
            canonical(prediction.actor.body) !== canonical(actual.body)
          )
            throw new Error(`Predicted controller mismatch ${scenario}/${players}/${tick}/${slot}`);
          coverage.run ||= Boolean(actual.body.vx && actual.action.kind === "fire");
          coverage.jump ||= Boolean(!actual.body.grounded && actual.action.kind === "fire");
          const now = tick * 20;
          ledger.synchronize(
            prediction.cues,
            {
              tick: tick - 1,
              acknowledgedSequence: tick - 1,
              eventCursor: cursor - events.length,
            },
            cursor - events.length,
            now,
          );
          ledger.presented(
            ledger.visible(now + 1).map((item) => item.id),
            now + 1,
          );
          for (const event of events) {
            ledger.confirm(event, now + 5);
            ledger.confirm(event, now + 6);
          }
          ledger.synchronize(
            [],
            { tick, acknowledgedSequence: tick, eventCursor: cursor },
            cursor,
            now + 7,
          );
          markers += cues.length;
        }
        hash = stateHash([hash, predictions.map((p) => p.cues), events]);
        world = next;
      }
      const counts = feedback.map(({ status }) => ({
        predicted: status.predicted,
        presented: status.presented,
        promoted: status.promoted,
        authoritative: status.authoritative,
        rejected: status.rejected,
        evicted: status.evicted,
      }));
      if (
        counts.some(
          (c) =>
            c.predicted !== c.promoted ||
            c.presented !== c.predicted ||
            c.rejected ||
            c.authoritative ||
            c.evicted,
        )
      )
        throw new Error("Feedback did not confirm exactly once");
      if (movement.some((m) => !m.run || !m.jump)) throw new Error("Firing froze locomotion");
      return { scenario, players, ticks: world.tick, markers, counts, movement, hash };
    }),
  );
}
