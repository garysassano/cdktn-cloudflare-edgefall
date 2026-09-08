import { describe, expect, it } from "vitest";
import {
  type WeaponPickupDefinition,
  createWeaponPickups,
  stepWeaponPickups,
  validateWeaponPickups,
} from "../src/game/combat/pickups.js";
import { canonical } from "../src/game/core/canonical.js";
import { createCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_CATALOG } from "../src/game/labs/combat-content.js";
import { moveKinematic } from "../src/game/physics/move.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import type { WeaponId } from "../src/game/state.js";
import { weaponPickupProof } from "./fixtures/weapon-pickup-proof.js";

const floor: SweepTarget = {
  id: 100,
  kind: "solid",
  rect: { x: -100, y: 100, w: 1000, h: 20 },
  delta: { x: 0, y: 0 },
};
const def: WeaponPickupDefinition = {
  id: 300,
  claimId: 900,
  sourceId: 200,
  kind: "weapon",
  weaponId: "heavy-machine-gun",
  ammo: 150,
  ammoLimit: 150,
  activationTick: 1,
  expiresTick: 120,
  supportId: 100,
  rect: { x: 50, y: 80, w: 10, h: 20 },
};
const player = (slot = 0) => {
  const actor = createCombatLab("range", slot + 1).players[slot];
  if (!actor) throw new Error("Missing fixture player");
  actor.weapon = { ...actor.weapon, id: "sidearm", ammo: 0 };
  return actor;
};
const travel = (x: number, dx = 0, y = 80, dy = 0, terrain = [floor]) =>
  moveKinematic(
    {
      rect: { x, y, w: 10, h: 20 },
      motion: { x: dx, y: dy },
      supportId: y === 80 ? 100 : null,
    },
    terrain,
  );
const initial = (defs = [def], terrain = [floor]) =>
  createWeaponPickups(defs, COMBAT_CATALOG, terrain);
const step = (
  state = initial(),
  defs = [def],
  players = [player()],
  moves = new Map([[1, travel(50)]]),
  terrain = [floor],
) => stepWeaponPickups(state, defs, players, moves, terrain, COMBAT_CATALOG);

const requiredItem = (state: ReturnType<typeof initial>) => {
  const item = state.items[0];
  if (!item) throw new Error("Missing pickup fixture item");
  return item;
};

describe("individual weapon supplies", () => {
  it("replays real four-player controller paths through all finite weapons and ammunition exhaustion", () => {
    const proof = weaponPickupProof();
    expect(proof.claims).toHaveLength(20);
    expect(new Set(proof.claims.map((claim) => claim.claimId)).size).toBe(20);
    expect(proof.laserShots.map((shot) => shot.tick)).toEqual([
      100, 100, 100, 100, 106, 106, 106, 106,
    ]);
    expect(proof.checkpoints.some((checkpoint) => checkpoint.contacts > 0)).toBe(true);
  });
  it("awards simultaneous contact once, with player-slot order independent of insertion order", () => {
    const actors = [player(0), player(1), player(2), player(3)];
    const movement = new Map(actors.map((p) => [p.playerId, travel(50)]));
    const before = canonical(actors),
      saved = initial();
    const result = step(saved, [def], actors, movement);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ playerId: 1, slot: 0, claimId: 900, ammo: 150 });
    expect(
      step(saved, [def], [...actors].reverse(), new Map([...movement].reverse())).claims,
    ).toEqual(result.claims);
    expect(canonical(actors)).toBe(before);
    expect(saved).toEqual(initial());
    expect(step(result.state, [def], result.players, movement).claims).toEqual([]);
  });

  it("earlier swept contact beats a lower player slot, including contact between endpoints", () => {
    const result = step(
      initial(),
      [def],
      [player(), player(1)],
      new Map([
        [1, travel(0, 100)],
        [2, travel(30, 60)],
      ]),
    );
    expect(result.claims.map((claim) => claim.playerId)).toEqual([2]);
  });

  it("orders competing items by contact time before claim ID", () => {
    const later = {
      ...def,
      id: 301,
      claimId: 1,
      weaponId: "shotgun" as const,
      ammo: 24,
      ammoLimit: 24,
      rect: { ...def.rect, x: 80 },
    };
    const defs = [later, def];
    const result = step(initial(defs), defs, [player()], new Map([[1, travel(0, 100)]]));
    expect(result.claims.map((claim) => claim.id)).toEqual([300, 301]);
    expect(result.players[0]?.weapon.id).toBe("shotgun");
    expect(
      step(
        initial([...defs].reverse()),
        [...defs].reverse(),
        [player()],
        new Map([[1, travel(0, 100)]]),
      ).claims,
    ).toEqual(result.claims);
  });

  it("uses claim ID to resolve equal-time items reproducibly", () => {
    const other = {
      ...def,
      id: 301,
      claimId: 1,
      weaponId: "shotgun" as const,
      ammo: 24,
      ammoLimit: 24,
    };
    const defs = [def, other];
    expect(step(initial(defs), defs).claims.map((claim) => claim.claimId)).toEqual([1, 900]);
  });

  it("leaves a full player's supply for another player instead of consuming a zero grant", () => {
    const full = player();
    full.weapon = { ...full.weapon, id: "heavy-machine-gun", ammo: 150 };
    const result = step(
      initial(),
      [def],
      [full, player(1)],
      new Map([
        [1, travel(50)],
        [2, travel(50)],
      ]),
    );
    expect(result.claims.map((claim) => claim.playerId)).toEqual([2]);
  });

  it("adds bounded ammunition without restarting the same weapon's paid action", () => {
    const actor = player();
    actor.weapon = {
      id: "heavy-machine-gun",
      ammo: 130,
      cooldownTicks: 4,
      shotOrdinal: 7,
      lastActionInstanceId: 9,
    };
    actor.action = {
      kind: "fire",
      actionInstanceId: 9,
      stateStartTick: 1,
      definitionId: 14,
      nextMarkerIndex: 2,
    };
    const result = step(initial(), [def], [actor]);
    expect(result.players[0]?.weapon).toEqual({ ...actor.weapon, ammo: 150 });
    expect(result.players[0]?.action).toEqual(actor.action);
    expect(result.players[0]?.controlEpoch).toBe(actor.controlEpoch);
  });

  it("requires leaving and re-entering before taking another item from a pile", () => {
    const defs = [def, { ...def, id: 301, claimId: 901 }];
    const first = step(initial(defs), defs);
    expect(first.claims).toHaveLength(1);
    const actor = first.players[0];
    if (!actor) throw new Error("Missing player");
    actor.weapon.ammo--;
    const held = step(JSON.parse(JSON.stringify(first.state)), defs, [actor]);
    expect(held.claims).toEqual([]);
    expect(held.players[0]?.weapon.ammo).toBe(149);
    const departed = step(held.state, defs, held.players, new Map([[1, travel(50, -30)]]));
    expect(departed.claims).toEqual([]);
    expect(departed.state.contacts).toEqual([]);
    const returned = step(departed.state, defs, departed.players, new Map([[1, travel(20, 30)]]));
    expect(returned.claims.map((claim) => claim.id)).toEqual([301]);
    expect(returned.players[0]?.weapon.ammo).toBe(150);
  });

  it("leaves three independent items available to approaching allies after the first claim", () => {
    const defs = Array.from({ length: 4 }, (_, i) => ({
      ...def,
      id: def.id + i,
      claimId: def.claimId + i,
    }));
    const actors = [player(), player(1), player(2), player(3)];
    let result = step(initial(defs), defs, actors, new Map([[1, travel(50)]]));
    expect(result.claims.map((claim) => claim.playerId)).toEqual([1]);
    const first = result.players[0];
    if (!first) throw new Error("Missing player");
    first.weapon.ammo--;
    result = step(
      result.state,
      defs,
      result.players,
      new Map(actors.map((p) => [p.playerId, travel(50)])),
    );
    expect(result.claims.map((claim) => claim.playerId)).toEqual([2, 3, 4]);
    expect(result.players.map((p) => p.weapon.ammo)).toEqual([149, 150, 150, 150]);
  });

  it.each([
    "heavy-machine-gun",
    "shotgun",
    "rocket-launcher",
    "flamethrower",
    "laser",
  ] as WeaponId[])(
    "replaces a carried gun with %s while preserving paid cooldown and confirmation counters",
    (weaponId) => {
      const pickupAmmo = COMBAT_CATALOG.firearms.get(weaponId)?.weapon.pickupAmmo;
      if (typeof pickupAmmo !== "number") throw new Error("Missing finite pickup");
      const definition = { ...def, weaponId, ammo: pickupAmmo, ammoLimit: pickupAmmo };
      const actor = player();
      actor.weapon = {
        ...actor.weapon,
        cooldownTicks: 17,
        shotOrdinal: 8,
        lastActionInstanceId: 11,
      };
      actor.action = {
        kind: "fire",
        actionInstanceId: 11,
        stateStartTick: 1,
        definitionId: 10,
        nextMarkerIndex: 2,
      };
      const result = step(initial([definition]), [definition], [actor]);
      expect(result.players[0]?.weapon).toEqual({
        ...actor.weapon,
        id: weaponId,
        ammo: pickupAmmo,
      });
      expect(result.players[0]?.action).toMatchObject({
        kind: "ready",
        actionInstanceId: 0,
        nextMarkerIndex: 0,
      });
      expect(result.players[0]?.controlEpoch).toBe(actor.controlEpoch);
      expect(result.claims[0]).toMatchObject({
        previousWeaponId: "sidearm",
        previousAmmo: 0,
        ammo: pickupAmmo,
      });
    },
  );

  it("preserves a grenade's already accepted release clock during a weapon swap", () => {
    const actor = player();
    actor.action = {
      kind: "grenade",
      actionInstanceId: 4,
      definitionId: 51,
      stateStartTick: 1,
      nextMarkerIndex: 1,
    };
    expect(step(initial(), [def], [actor]).players[0]?.action).toEqual(actor.action);
  });

  it.each(["death", "respawning", "spectating", "seated", "absent", "enter", "exit"])(
    "does not grant inventory to %s actors",
    (mode) => {
      const actor = player();
      if (mode === "seated") actor.vehicleId = 60;
      else if (mode === "absent") actor.bodyPresence = "removed";
      else if (mode === "enter" || mode === "exit") actor.action.kind = mode;
      else actor.life = mode as "death" | "respawning" | "spectating";
      expect(step(initial(), [def], [actor]).claims).toEqual([]);
    },
  );

  it("activates and expires at exact boundaries, with JSON restoration retaining terminal claims", () => {
    const delayed = { ...def, activationTick: 2, expiresTick: 4 },
      defs = [delayed];
    const first = step(initial(defs), defs);
    expect(first.claims).toEqual([]);
    const claimed = step(JSON.parse(JSON.stringify(first.state)), defs);
    expect(claimed.claims[0]?.tick).toBe(2);
    expect(step(JSON.parse(JSON.stringify(claimed.state)), defs, claimed.players).claims).toEqual(
      [],
    );
    let state = initial(defs);
    for (let tick = 1; tick <= 4; tick++) state = step(state, defs, [player()], new Map()).state;
    expect(state.items[0]).toMatchObject({ status: "expired", resolvedTick: 4, claimedBy: null });
    expect(step(state, defs).claims).toEqual([]);
  });

  it("rejects unsafe spawns and retires a supply when its support is destroyed", () => {
    expect(() => initial([def], [])).toThrow("Unsafe pickup spawn");
    expect(() => initial([{ ...def, rect: { ...def.rect, y: 81 } }])).toThrow(
      "Unsafe pickup spawn",
    );
    expect(
      step(initial(), [def], [player()], new Map([[1, travel(50)]]), []).state.items[0],
    ).toMatchObject({ status: "unsupported", resolvedTick: 1 });
  });

  it("follows collision-clipped travel rather than collecting through a wall", () => {
    const wall: SweepTarget = {
      id: 101,
      kind: "solid",
      rect: { x: 30, y: 0, w: 5, h: 100 },
      delta: { x: 0, y: 0 },
    };
    const terrain = [floor, wall],
      movement = travel(0, 100, 80, 0, terrain);
    expect(movement.status).toBe("complete");
    expect(movement.rect.x).toBe(20);
    expect(
      step(initial([def], terrain), [def], [player()], new Map([[1, movement]]), terrain).claims,
    ).toEqual([]);
  });

  it("uses the post-contact slide and its remaining time when comparing players", () => {
    const landing = travel(0, 100, 40, 80);
    expect(landing.path).toHaveLength(2);
    // The first actor reaches x=70 after landing; a straight endpoint chord misses this timing.
    const later = { ...def, rect: { ...def.rect, x: 80 } };
    const result = step(
      initial([later]),
      [later],
      [player(), player(1)],
      new Map([
        [1, landing],
        [2, travel(60, 20)],
      ]),
    );
    expect(result.claims[0]?.playerId).toBe(2);
  });

  it("rejects duplicate identities, forged lifetime/claim state and unknown fields", () => {
    expect(() => initial([def, { ...def, id: 301 }])).toThrow("Duplicate pickup identity");
    expect(() => initial([{ ...def, ammoLimit: 149 }])).toThrow();
    const ids = new Set([1]);
    for (const corrupt of [
      (state: ReturnType<typeof initial>) => {
        requiredItem(state).claimedBy = 1;
      },
      (state: ReturnType<typeof initial>) => {
        requiredItem(state).status = "available";
      },
      (state: ReturnType<typeof initial>) => {
        state.items.push({ ...requiredItem(state) });
      },
      (state: ReturnType<typeof initial>) => {
        Object.assign(requiredItem(state), { extra: true });
      },
    ]) {
      const state = initial();
      corrupt(state);
      expect(() => validateWeaponPickups(state, [def], COMBAT_CATALOG, ids)).toThrow();
    }
  });
});
