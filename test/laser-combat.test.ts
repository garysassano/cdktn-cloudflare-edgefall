import { beforeAll, describe, expect, it } from "vitest";
import { damagePlayer } from "../src/game/campaign/life.js";
import { LASER_ATTACK, LASER_PROFILE } from "../src/game/content/weapons/laser.js";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { type CombatCommand, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { combatEventContext } from "../src/shared/diagnostics/combat-events.js";
import { transitionCombatRuntime } from "../src/shared/diagnostics/combat-recovery.js";
import { combatPeerContext } from "../src/shared/diagnostics/combat-workload.js";
import {
  EventReceiver,
  createEventHistory,
  eventBatches,
  stageEventTick,
} from "../src/shared/protocol/event-stream.js";
import { decodeEventBatch, encodeEventBatch } from "../src/shared/protocol/events.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import {
  LASER_COMBAT_BOUNDARIES,
  laserCombatProof,
  recordLaserCombat,
} from "./fixtures/laser-combat-proof.js";

const idle: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  interactPressed: false,
};
const fire = { ...idle, held: Held.Fire, firePressed: true };
let fixture: ReturnType<typeof recordLaserCombat>;
beforeAll(() => {
  fixture = recordLaserCombat();
});

describe("accepted laser charges and room continuation", () => {
  it("preserves short taps and deduplicates onset/held charges despite repeated input packets", () => {
    expect(fixture.duplicates).toBe(288);
    for (const playerId of [1, 2, 3, 4])
      expect(
        fixture.states.flatMap((s) =>
          s.combat.events
            .filter((e) => e.kind === "shot" && e.ownerId === playerId)
            .map(() => s.combat.tick),
        ),
      ).toEqual([1, 7, 13, 19, 31, 37, 49]);
    expect(
      fixture.state.combat.players.map((p) => [p.weapon.ammo, p.weapon.shotOrdinal, p.lives]),
    ).toEqual(Array(4).fill([113, 7, 3]));
    expect(fixture.state.combat.beams).toEqual([]);
    for (const state of fixture.states) validateCombatCheckpoint(state);
  });

  it("reconstructs public segments and paid private state through every archive/journal boundary", async () => {
    const proof = await laserCombatProof();
    expect(proof.checkpoints.map((c) => c.tick)).toEqual(LASER_COMBAT_BOUNDARIES);
    const state = fixture.states[8];
    if (!state) throw new Error("Missing active charge");
    const context = combatPeerContext(state.snapshot, 0);
    const decoded = decodeSnapshot(encodeSnapshot(state.snapshot, context), context);
    expect(canonical(decoded)).toBe(canonical(state.snapshot));
    expect(decoded.combat?.volumes).toHaveLength(8);
    expect(decoded.combat?.volumes[0]).toMatchObject({
      definitionId: 18,
      spawnTick: 7,
      endTick: 13,
      heading: 1,
      attached: true,
    });
    expect(decoded.projectiles.some((p) => p.definitionId === 18)).toBe(false);
  });

  it("grants two damage per target every six accepted ticks, with no contact damage between pulses", () => {
    let world = createCombatLab("laser");
    const target = world.targets[0];
    if (!target) throw new Error("Missing durable target");
    target.health = 20;
    const impacts: number[] = [];
    for (let tick = 1; tick <= 19; tick++) {
      world = stepCombatLab(world, [{ ...fire, firePressed: tick === 1 }]);
      if (
        world.events.some(
          (event) => event.kind === "impact" && event.targetId === target.enemy.body.id,
        )
      )
        impacts.push(tick);
    }
    expect(impacts).toEqual([1, 7, 13, 19]);
    expect(world.targets[0]?.health).toBe(12);
    expect(world.players[0]?.weapon.ammo).toBe(116);
  });

  it("spends a blocked charge once without emitting a beam beyond the wall", () => {
    const world = createCombatLab("wall");
    const actor = world.players[0];
    if (!actor) throw new Error("Missing player");
    actor.weapon = { ...actor.weapon, id: "laser", ammo: 120 };
    actor.body.x = pixels(125);
    const next = stepCombatLab(world, [fire]);
    expect(next.players[0]?.weapon.ammo).toBe(119);
    expect(next.beams).toEqual([]);
    expect(next.events.filter((e) => e.kind === "muzzle-blocked")).toHaveLength(1);
    expect(next.events.every((e) => e.beam === null)).toBe(true);
  });

  it("clips a pulse at a shield and leaves the body behind it unharmed", () => {
    const world = createCombatLab("shield");
    const actor = world.players[0];
    if (!actor) throw new Error("Missing player");
    actor.weapon = { ...actor.weapon, id: "laser", ammo: 120 };
    const next = stepCombatLab(world, [fire]);
    const pulse = next.events.find((e) => e.kind === "shot");
    expect(pulse?.beam?.length).toBeLessThan(LASER_PROFILE.range);
    expect(next.events.filter((e) => e.kind === "impact").map((e) => e.impact?.kind)).toEqual([
      "shield",
    ]);
    expect(next.targets.map((target) => target.health)).toEqual(
      world.targets.map((target) => target.health),
    );
  });

  it("follows held movement and aim without retaining a released tap", () => {
    expect(fixture.states[1]?.combat.beams).toHaveLength(4);
    expect(fixture.states[2]?.combat.beams).toHaveLength(0);
    expect(fixture.states[8]?.combat.beams.every((beam) => beam.heading === 1)).toBe(true);
    expect(fixture.states[32]?.combat.beams[0]?.origin.x).toBeGreaterThan(
      fixture.states[31]?.combat.beams[0]?.origin.x ?? Infinity,
    );
    expect(fixture.states[43]?.combat.beams).toHaveLength(0);
  });

  it("cancels visible energy when movement puts the muzzle through cover between pulse ticks", () => {
    let world = createCombatLab("wall");
    const actor = world.players[0];
    if (!actor) throw new Error("Missing player");
    actor.body.x = pixels(115);
    actor.weapon = { ...actor.weapon, id: "laser", ammo: 120 };
    for (let tick = 1; tick <= 7; tick++) {
      world = stepCombatLab(world, [
        { ...fire, held: Held.Fire | Held.Right, firePressed: tick === 1 },
      ]);
      expect(world.players[0]?.weapon.ammo).toBe(tick < 7 ? 119 : 118);
      expect(world.beams).toHaveLength(tick < 3 ? 1 : 0);
      if (tick > 1 && tick < 7) expect(world.events).toEqual([]);
    }
    expect(world.events.filter((event) => event.kind === "muzzle-blocked")).toHaveLength(1);
  });

  it("breaks a live shield with two energy pulses before the next pulse reaches its body", () => {
    let world = createCombatLab("guard");
    const actor = world.players[0];
    if (!actor) throw new Error("Missing player");
    actor.weapon = { ...actor.weapon, id: "laser", ammo: 120 };
    const contacts: Array<[number, string | undefined]> = [],
      breaks: number[] = [];
    for (let tick = 1; tick <= 13; tick++) {
      world = stepCombatLab(world, [{ ...fire, firePressed: tick === 1 }]);
      for (const event of world.events) {
        if (event.kind === "impact" && event.targetId === 20)
          contacts.push([tick, event.impact?.kind]);
        if (event.kind === "shield-break") breaks.push(tick);
      }
      if (tick < 13) expect(world.targets[0]?.health).toBe(1);
    }
    expect(contacts).toEqual([
      [1, "shield"],
      [7, "shield"],
      [13, "body"],
    ]);
    expect(breaks).toEqual([7]);
    expect(world.targets[0]?.guard).toMatchObject({ integrity: 0, phase: "dead" });
  });

  it("spends the last energy once and falls back to the sidearm at the next accepted boundary", () => {
    let world = createCombatLab("laser");
    if (!world.players[0]) throw new Error("Missing player");
    world.players[0].weapon.ammo = 1;
    const shots: Array<[number, number | undefined]> = [];
    for (let tick = 1; tick <= 15; tick++) {
      world = stepCombatLab(world, [{ ...fire, firePressed: tick === 1 }]);
      for (const event of world.events.filter((event) => event.kind === "shot"))
        shots.push([tick, event.source?.definitionId]);
    }
    expect(shots).toEqual([
      [1, 18],
      [7, 1],
      [15, 1],
    ]);
    expect(world.players[0]?.weapon).toMatchObject({ id: "sidearm", ammo: 0 });
    expect(world.beams).toEqual([]);
  });

  it("ends an attached charge on owner death without refund or repeated damage", () => {
    let world = stepCombatLab(createCombatLab("laser"), [fire]);
    const actor = world.players[0];
    if (!actor) throw new Error("Missing player");
    world.players[0] = damagePlayer(actor, world.tick, 1, "classic", "fall").actor;
    world = stepCombatLab(world, [fire]);
    expect(world.beams).toEqual([]);
    expect(world.events.some((event) => event.source?.definitionId === LASER_ATTACK.id)).toBe(
      false,
    );
  });

  it("settles held charges on pause and recovery while preserving their paid energy and cooldown", () => {
    const current = fixture.states[8];
    if (!current) throw new Error("Missing recovery boundary");
    const paused = transitionCombatRuntime(current, "pause");
    expect(paused.combat.beams).toEqual([]);
    expect(paused.combat.players.map((p) => p.weapon.ammo)).toEqual(
      current.combat.players.map((p) => p.weapon.ammo),
    );
    validateCombatCheckpoint(paused);
    const recovered = transitionCombatRuntime(paused, "recover");
    expect(recovered.combat.beams).toEqual([]);
    expect(recovered.combat.players.map((p) => p.weapon.cooldownTicks)).toEqual(
      current.combat.players.map((p) => p.weapon.cooldownTicks),
    );
    validateCombatCheckpoint(recovered);
  });

  it("rejects forged charge clocks, muzzle geometry, duplicate owners and unknown state fields", () => {
    for (const change of [
      { tick: 7 },
      { spawnTick: 1 },
      { heading: 0 },
      { length: pixels(513) },
      { hits: [] },
    ]) {
      const state = structuredClone(fixture.states[8]);
      if (!state?.combat.beams[0]) throw new Error("Missing beam");
      Object.assign(state.combat.beams[0], change);
      expect(() => validateCombatCheckpoint(state)).toThrow();
    }
    const state = structuredClone(fixture.states[8]);
    if (!state?.combat.beams[0] || !state.combat.beams[1]) throw new Error("Missing beam pair");
    state.combat.beams[1].ownerId = state.combat.beams[0].ownerId;
    state.combat.beams[1].actionInstanceId = state.combat.beams[0].actionInstanceId;
    expect(() => validateCombatCheckpoint(state)).toThrow(/duplicate beam owner/);
  });

  it("retains exact birth geometry after the tap vanishes and delivers it once after a delayed retry", () => {
    const first = fixture.states[1]?.history.entries.find((entry) => entry.event.kind === "shot");
    const initial = fixture.states[0];
    if (!first || !initial) throw new Error("Missing tap receipt");
    const context = combatEventContext(initial.snapshot),
      receiver = new EventReceiver(context, initial.snapshot);
    let history = createEventHistory(initial.snapshot.runEpoch);
    for (let tick = 1; tick <= 20; tick++)
      history = stageEventTick(history, tick, tick === 1 ? [first.event] : [], context);
    const batch = eventBatches(history, 0, context.connectionEpoch)?.[0];
    if (!batch) throw new Error("Missing retained tap");
    const bytes = encodeEventBatch(batch, context),
      decoded = decodeEventBatch(bytes, context);
    const events = receiver.consume(decoded);
    expect(events).toHaveLength(1);
    expect(events[0]?.event.beam).toEqual(first.event.beam);
    expect(receiver.consume(decoded)).toEqual([]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([
      view.getUint32(96, true),
      view.getUint32(100, true),
      view.getUint32(104, true),
    ]).toEqual([pixels(512), pixels(4), 0]);
    for (const offset of [100, 104]) {
      const malformed = bytes.slice();
      new DataView(malformed.buffer).setUint32(offset, offset === 100 ? 4097 : 4, true);
      expect(() => decodeEventBatch(malformed, context)).toThrow();
    }
    expect(() =>
      encodeEventBatch(
        {
          ...batch,
          events: [{ ...first, cursor: 1, counter: 0, event: { ...first.event, beam: null } }],
        },
        context,
      ),
    ).toThrow(/geometry presence/);
  });
});
