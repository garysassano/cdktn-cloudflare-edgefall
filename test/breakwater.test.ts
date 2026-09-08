import { describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import {
  createBreakwater,
  replayBreakwater,
  stepBreakwater,
} from "../src/game/missions/breakwater.js";
import { BREAKWATER } from "../src/game/missions/breakwater-content.js";
import { runBreakwaterProof } from "./fixtures/breakwater-proof.js";

const neutral = {
  held: 0,
  firePressed: false,
  jumpPressed: false,
  grenadePressed: false,
  interactPressed: false,
};

describe("Breakwater Approach", () => {
  it.each([2, 4])(
    "finishes a complete %i-player input recording with every player participating and alive",
    { timeout: 20000 },
    (count) => {
      const shooters = new Set<number>();
      let previous = createBreakwater(count),
        forcedEjections = 0;
      const proof = runBreakwaterProof((state) => {
        if (
          previous.combat.players[0]?.vehicleId !== null &&
          state.combat.players[0]?.vehicleId === null
        ) {
          expect(previous.combat.players[0]?.action.kind).not.toBe("exit");
          expect(state.combat.players[0]).toMatchObject({ life: "alive", invulnerableTicks: 12 });
          expect(state.combat.tanks[0]).toMatchObject({
            armor: 0,
            lifecycle: "wreck",
            occupantId: null,
          });
          forcedEjections++;
        }
        if (state.boss.phase !== "dormant")
          for (const event of state.combat.events)
            if (event.kind === "shot" && event.source?.definitionId === 2)
              shooters.add(event.ownerId);
        previous = state;
      }, count);
      expect(proof.state.phase).toBe("victory");
      expect(proof.state.combat.tick).toBeGreaterThanOrEqual(2700);
      expect(proof.state.combat.tick).toBeLessThanOrEqual(3600);
      expect(
        proof.state.combat.players.every((p) => p.life === "alive" && p.body.x / 256 > 2600),
      ).toBe(true);
      expect(shooters.size).toBe(count);
      expect(forcedEjections).toBe(1);
      expect(canonical(replayBreakwater(proof.recording))).toBe(proof.recording.finalState);
    },
  );
  // This replays the complete mission four times, including rejection
  // and observer-isolation checks, alongside the other kernel suites.
  it("finishes one continuous input recording with the weapon, enemy, life, vehicle and boss beats", {
    timeout: 20_000,
  }, () => {
    const kinds = new Set<string>(),
      weapons = new Set<number>(),
      lives = new Set<string>(),
      armor = new Set<number>(),
      phases = new Set<string>(),
      actions = new Set<string>();
    let tankJump = false,
      tankLanding = false,
      forcedEjections = 0,
      previous = createBreakwater();
    const proof = runBreakwaterProof((state) => {
      for (const e of state.combat.events) {
        kinds.add(e.kind);
        if (e.kind === "shot" && e.source) weapons.add(e.source.definitionId);
      }
      lives.add(state.combat.players[0]?.life ?? "missing");
      actions.add(state.combat.players[0]?.action.kind ?? "missing");
      armor.add(state.combat.tanks[0]?.armor ?? -1);
      phases.add(state.boss.phase);
      if (
        previous.combat.players[0]?.vehicleId !== null &&
        state.combat.players[0]?.vehicleId === null
      ) {
        expect(previous.combat.players[0]?.action.kind).not.toBe("exit");
        expect(state.combat.players[0]).toMatchObject({ life: "alive", invulnerableTicks: 12 });
        expect(state.combat.tanks[0]).toMatchObject({
          armor: 0,
          lifecycle: "wreck",
          occupantId: null,
        });
        forcedEjections++;
      }
      if (previous.combat.tanks[0]?.body.grounded && !state.combat.tanks[0]?.body.grounded)
        tankJump = true;
      if (
        !previous.combat.tanks[0]?.body.grounded &&
        state.combat.tanks[0]?.body.grounded &&
        state.combat.tick > 0
      )
        tankLanding = true;
      previous = state;
    });
    expect(proof.state.phase).toBe("victory");
    expect(proof.state.combat.tick).toBeGreaterThanOrEqual(45 * 60);
    expect(proof.state.combat.tick).toBeLessThanOrEqual(60 * 60);
    expect(proof.state.checkpoint).toBe(2);
    expect(proof.state.combat.targets.every((t) => t.health === 0)).toBe(true);
    expect(proof.state.combat.props[0]?.health).toBe(0);
    expect([...weapons]).toEqual(expect.arrayContaining([1, 2, 10, 11, 16]));
    expect([...kinds]).toEqual(
      expect.arrayContaining(["throw", "explosion", "shield-break", "prop-destroyed"]),
    );
    expect([...lives]).toEqual(expect.arrayContaining(["alive", "death", "respawning"]));
    expect(actions.has("enter")).toBe(true);
    expect(actions.has("exit")).toBe(false);
    expect(forcedEjections).toBe(1);
    expect([...armor]).toEqual(expect.arrayContaining([3, 2, 1, 0]));
    expect([...phases]).toEqual(
      expect.arrayContaining(["dormant", "windup", "burst", "recovery", "destroyed"]),
    );
    expect(tankJump && tankLanding).toBe(true);
    expect(
      canonical(
        replayBreakwater(proof.recording, (state) => {
          state.boss.health = 999;
        }),
      ),
    ).toBe(proof.recording.finalState);
    expect(() =>
      replayBreakwater({ ...proof.recording, commands: [...proof.recording.commands, [neutral]] }),
    ).toThrow("Input after mission outcome");
    expect(() => replayBreakwater({ ...proof.recording, finalState: "altered" })).toThrow(
      "Mission replay diverged",
    );
  });

  it("keeps sleeping shields material to incoming bullets", () => {
    let state = createBreakwater();
    const actor = state.combat.players[0];
    if (!actor) throw new Error("Missing actor");
    actor.body.x = pixels(675);
    actor.weapon.id = "heavy-machine-gun";
    actor.weapon.ammo = 150;
    let shieldHits = 0;
    for (let tick = 0; tick < 45; tick++) {
      state = stepBreakwater(state, [{ ...neutral, held: Held.Fire, firePressed: tick === 0 }]);
      shieldHits += state.combat.events.filter(
        (e) => e.kind === "impact" && e.targetId === 22 && e.impact?.kind === "shield",
      ).length;
    }
    expect(shieldHits).toBeGreaterThan(0);
    expect(state.combat.targets.find((t) => t.enemy.body.id === 22)?.health).toBe(1);
    expect(state.combat.encounter.members.find((t) => t.id === 22)?.status).toBe("alive");
  });

  it("checks grenade hand clearance against the real mission wall", () => {
    let state = createBreakwater();
    const player = state.combat.players[0];
    if (!player) throw new Error("Missing player");
    player.body.x = pixels(BREAKWATER.boss.x - 48);
    for (let tick = 0; tick < 5; tick++)
      state = stepBreakwater(state, [{ ...neutral, grenadePressed: tick === 0 }]);
    const release = state.combat.events.find((e) => e.kind === "throw");
    expect(release?.position.x).toBe(pixels(BREAKWATER.boss.x - 43));
    expect(() => stepBreakwater(state, [neutral])).not.toThrow();
  });

  it("only damages the engine through its recovery aperture", () => {
    let state = createBreakwater();
    const player = state.combat.players[0];
    if (!player) throw new Error("Missing player");
    player.body.x = pixels(2700);
    player.weapon.id = "heavy-machine-gun";
    player.weapon.ammo = 100;
    const health = state.boss.health;
    let closedHits = 0,
      openHits = 0;
    for (let tick = 0; tick < 170; tick++) {
      const attack = tick < 35 || tick >= 126;
      state = stepBreakwater(state, [
        { ...neutral, held: (tick < 126 ? Held.Down : 0) | (attack ? Held.Fire : 0) },
      ]);
      for (const event of state.combat.events.filter(
        (e) => e.kind === "impact" && e.targetId === BREAKWATER.boss.id,
      )) {
        if (event.impact?.kind === "shield") closedHits++;
        if (event.impact?.kind === "body") {
          expect(state.boss.phase).toBe("recovery");
          openHits++;
        }
      }
      if (tick < 126) expect(state.boss.health).toBe(health);
    }
    expect(closedHits).toBeGreaterThan(0);
    expect(openHits).toBeGreaterThan(0);
    expect(state.boss.health).toBeLessThan(health);
  });

  it.each([1, 2, 4])("provides %i individual shared supplies with no duplicate grants", (count) => {
    let state = createBreakwater(count);
    for (const player of state.combat.players) player.body.x = pixels(576);
    const epochs = state.combat.players.map((p) => p.controlEpoch);
    state = stepBreakwater(
      state,
      state.combat.players.map(() => neutral),
    );
    const claimed = state.supplies.items.filter((item) => item.status === "claimed");
    expect(claimed).toHaveLength(count);
    expect(new Set(claimed.map((item) => item.claimedBy)).size).toBe(count);
    expect(
      state.combat.players.every(
        (p) => p.weapon.id === "heavy-machine-gun" && p.weapon.ammo === 150,
      ),
    ).toBe(true);
    expect(state.notices.filter((notice) => notice.kind === "pickup")).toHaveLength(count);
    state = stepBreakwater(
      state,
      state.combat.players.map(() => ({ ...neutral, interactPressed: true })),
    );
    expect(state.notices).toHaveLength(0);
    expect(state.combat.players.map((p) => p.controlEpoch)).toEqual(epochs);
  });

  it("rejects invalid input or content without changing the accepted state", () => {
    const state = createBreakwater(),
      before = canonical(state);
    expect(() => stepBreakwater(state, [{ ...neutral, held: -1 }])).toThrow();
    expect(() => stepBreakwater(state, [])).toThrow();
    expect(() => stepBreakwater({ ...state, contentHash: "old" }, [neutral])).toThrow(
      "Mission content mismatch",
    );
    expect(canonical(state)).toBe(before);
    expect(() => createBreakwater(5)).toThrow();
    expect(() => createBreakwater(1, 0)).toThrow();
    expect(canonical(createBreakwater(4, 123))).toBe(canonical(createBreakwater(4, 123)));
    expect(createBreakwater(4, 123).combat.targets).not.toEqual(
      createBreakwater(4, 124).combat.targets,
    );
  });
});
