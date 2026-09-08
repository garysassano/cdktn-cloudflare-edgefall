import {
  COUNTER_LIMIT,
  MAX_SHAPE,
  compareContactTime,
  integer,
  position,
} from "../core/numeric.js";
import type { MovementResult } from "../physics/move.js";
import { type SweepTarget, sweepAabb, validateSweepTarget } from "../physics/sweep.js";
import type { ControlledActor, Rect, WeaponId } from "../state.js";
import type { FirearmCatalog } from "./firearm.js";

export const MAX_WEAPON_PICKUPS = 64;
export interface WeaponPickupDefinition {
  id: number;
  claimId: number;
  sourceId: number;
  kind: "weapon";
  weaponId: WeaponId;
  ammo: number;
  ammoLimit: number;
  activationTick: number;
  expiresTick: number;
  supportId: number;
  rect: Rect;
}
export interface WeaponPickupState {
  format: 1;
  tick: number;
  /** Contact-entry latches prevent a held firing player draining the remaining pile one round at a time. */
  contacts: Array<{ id: number; playerId: number }>;
  items: Array<{
    id: number;
    status: "dormant" | "available" | "claimed" | "expired" | "unsupported";
    resolvedTick: number | null;
    claimedBy: number | null;
  }>;
}
export interface WeaponPickupClaim {
  id: number;
  claimId: number;
  sourceId: number;
  playerId: number;
  slot: number;
  tick: number;
  weaponId: WeaponId;
  previousWeaponId: WeaponId;
  previousAmmo: number;
  ammo: number;
}

function fields(value: object, expected: string): void {
  if (Object.keys(value).sort().join(" ") !== expected.split(" ").sort().join(" "))
    throw new Error("Unexpected pickup fields");
}
function definitions(defs: readonly WeaponPickupDefinition[], catalog: FirearmCatalog) {
  integer(defs.length, 0, MAX_WEAPON_PICKUPS, "pickup budget");
  const ids = new Set<number>(),
    claims = new Set<number>(),
    limits = new Map<WeaponId, number>();
  for (const def of defs) {
    fields(
      def,
      "id claimId sourceId kind weaponId ammo ammoLimit activationTick expiresTick supportId rect",
    );
    fields(def.rect, "x y w h");
    for (const value of [def.id, def.claimId, def.sourceId, def.supportId])
      integer(value, 1, COUNTER_LIMIT - 1, "pickup identity");
    if (ids.has(def.id) || claims.has(def.claimId)) throw new Error("Duplicate pickup identity");
    ids.add(def.id);
    claims.add(def.claimId);
    const weapon = catalog.firearms.get(def.weaponId)?.weapon;
    if (def.kind !== "weapon" || !weapon) throw new Error("Unknown pickup content");
    const unlimited = weapon.pickupAmmo === "unlimited";
    integer(def.ammoLimit, unlimited ? 0 : 1, unlimited ? 0 : 65535, "pickup inventory limit");
    integer(def.ammo, unlimited ? 0 : 1, def.ammoLimit, "pickup ammunition");
    if (limits.has(def.weaponId) && limits.get(def.weaponId) !== def.ammoLimit)
      throw new Error("Conflicting pickup inventory limits");
    limits.set(def.weaponId, def.ammoLimit);
    integer(def.activationTick, 1, COUNTER_LIMIT - 2, "pickup activation");
    integer(def.expiresTick, def.activationTick + 1, COUNTER_LIMIT - 1, "pickup expiry");
    integer(def.rect.w, 1, MAX_SHAPE, "pickup width");
    integer(def.rect.h, 1, MAX_SHAPE, "pickup height");
    for (const value of [def.rect.x, def.rect.y, def.rect.x + def.rect.w, def.rect.y + def.rect.h])
      position(value);
  }
}

/** Ground supplies require a stationary, unobstructed support; lost support retires the item. */
function supported(def: WeaponPickupDefinition, terrain: readonly SweepTarget[]): boolean {
  const support = terrain.find((surface) => surface.id === def.supportId);
  if (
    support?.delta.x !== 0 ||
    support.delta.y !== 0 ||
    def.rect.y + def.rect.h !== support.rect.y ||
    def.rect.x < support.rect.x ||
    def.rect.x + def.rect.w > support.rect.x + support.rect.w
  )
    return false;
  return !terrain.some(
    (surface) =>
      surface.kind === "solid" &&
      sweepAabb(def.rect, { x: 0, y: 0 }, surface.rect, surface.delta) !== null,
  );
}

export function createWeaponPickups(
  defs: readonly WeaponPickupDefinition[],
  catalog: FirearmCatalog,
  terrain: readonly SweepTarget[],
): WeaponPickupState {
  definitions(defs, catalog);
  for (const surface of terrain) validateSweepTarget(surface);
  if (defs.some((def) => !supported(def, terrain))) throw new Error("Unsafe pickup spawn");
  return {
    format: 1,
    tick: 0,
    contacts: [],
    items: [...defs]
      .sort((a, b) => a.id - b.id)
      .map((def) => ({
        id: def.id,
        status: "dormant",
        resolvedTick: null,
        claimedBy: null,
      })),
  };
}

export function validateWeaponPickups(
  state: WeaponPickupState,
  defs: readonly WeaponPickupDefinition[],
  catalog: FirearmCatalog,
  playerIds: ReadonlySet<number>,
): void {
  definitions(defs, catalog);
  fields(state, "format tick contacts items");
  if (state.format !== 1) throw new Error("Unsupported pickup format");
  integer(state.tick, 0, COUNTER_LIMIT - 1, "pickup tick");
  if (state.items.length !== defs.length) throw new Error("Pickup roster mismatch");
  const ordered = [...defs].sort((a, b) => a.id - b.id);
  for (const [index, item] of state.items.entries()) {
    fields(item, "id status resolvedTick claimedBy");
    const def = ordered[index];
    if (!def || item.id !== def.id) throw new Error("Pickup identity mismatch");
    if (!["dormant", "available", "claimed", "expired", "unsupported"].includes(item.status))
      throw new Error("Unknown pickup status");
    if (item.status === "dormant" || item.status === "available") {
      if (
        item.resolvedTick !== null ||
        item.claimedBy !== null ||
        state.tick >= def.expiresTick ||
        (item.status === "dormant") !== state.tick < def.activationTick
      )
        throw new Error("Pickup availability mismatch");
    } else {
      integer(
        item.resolvedTick as number,
        def.activationTick,
        state.tick,
        "pickup resolution tick",
      );
      if (
        item.status === "expired"
          ? item.resolvedTick !== def.expiresTick
          : (item.resolvedTick ?? 0) >= def.expiresTick
      )
        throw new Error("Pickup lifetime mismatch");
      if (
        item.status === "claimed"
          ? !playerIds.has(item.claimedBy as number)
          : item.claimedBy !== null
      )
        throw new Error("Pickup claimant mismatch");
    }
  }
  integer(state.contacts.length, 0, MAX_WEAPON_PICKUPS * 4, "pickup contact budget");
  let previous = { id: 0, playerId: 0 };
  for (const contact of state.contacts) {
    fields(contact, "id playerId");
    if (
      !playerIds.has(contact.playerId) ||
      !state.items.some((item) => item.id === contact.id && item.status === "available") ||
      contact.id < previous.id ||
      (contact.id === previous.id && contact.playerId <= previous.playerId)
    )
      throw new Error("Pickup contact roster/order mismatch");
    previous = contact;
  }
}

type Fraction = { n: bigint; d: bigint };
function compare(a: Fraction, b: Fraction): number {
  const difference = a.n * b.d - b.n * a.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
/** BigInt is temporary comparison arithmetic; every stored field remains a bounded JSON integer. */
function firstContact(movement: MovementResult, rect: Rect): Fraction | null {
  if (movement.status !== "complete") throw new Error("Unaccepted pickup movement");
  integer(movement.path.length, 1, 5, "pickup movement intervals");
  let elapsed: Fraction = { n: 0n, d: 1n },
    remaining: Fraction = { n: 1n, d: 1n };
  for (const interval of movement.path) {
    const { numerator: n, denominator: d } = interval.until;
    integer(d, 1, 2 ** 17, "pickup residual denominator");
    integer(n, 0, d, "pickup residual numerator");
    const hit = sweepAabb(interval.rect, interval.motion, rect);
    const time = hit?.kind === "overlap" ? { numerator: 0, denominator: 1 } : hit?.time;
    if (time && compareContactTime(time.numerator, time.denominator, n, d) <= 0) {
      return {
        n:
          elapsed.n * remaining.d * BigInt(time.denominator) +
          remaining.n * BigInt(time.numerator) * elapsed.d,
        d: elapsed.d * remaining.d * BigInt(time.denominator),
      };
    }
    elapsed = {
      n: elapsed.n * remaining.d * BigInt(d) + remaining.n * BigInt(n) * elapsed.d,
      d: elapsed.d * remaining.d * BigInt(d),
    };
    remaining = { n: remaining.n * BigInt(d - n), d: remaining.d * BigInt(d) };
  }
  return null;
}

function grant(
  actor: ControlledActor,
  def: WeaponPickupDefinition,
  tick: number,
): WeaponPickupClaim | null {
  const previous = { ...actor.weapon };
  const ammo =
    previous.id === def.weaponId ? Math.min(def.ammoLimit, previous.ammo + def.ammo) : def.ammo;
  if (previous.id === def.weaponId && ammo <= previous.ammo) return null;
  actor.weapon = { ...previous, id: def.weaponId, ammo };
  if (previous.id !== def.weaponId) {
    // Changing a gun cancels its remaining markers, but cannot refund energy or bypass cooldown.
    if (actor.action.kind === "fire")
      actor.action = {
        kind: "ready",
        actionInstanceId: 0,
        stateStartTick: tick,
        definitionId: 0,
        nextMarkerIndex: 0,
      };
    actor.firearmAim = {
      pitch: actor.locomotion === "crouched" ? 0 : actor.aim === 1 ? 4 : actor.aim === 2 ? -4 : 0,
      nextStepTick: 0,
    };
  }
  return {
    id: def.id,
    claimId: def.claimId,
    sourceId: def.sourceId,
    playerId: actor.playerId,
    slot: actor.slot,
    tick,
    weaponId: def.weaponId,
    previousWeaponId: previous.id,
    previousAmmo: previous.ammo,
    ammo,
  };
}

/** One accepted boundary: globally ordered contacts, then slot, then claim ID; no Interact edge is required. */
export function stepWeaponPickups(
  current: WeaponPickupState,
  defs: readonly WeaponPickupDefinition[],
  actors: readonly ControlledActor[],
  movements: ReadonlyMap<number, MovementResult>,
  terrain: readonly SweepTarget[],
  catalog: FirearmCatalog,
) {
  integer(actors.length, 1, 4, "pickup players");
  const playerIds = new Set<number>(),
    slots = new Set<number>();
  for (const actor of actors) {
    integer(actor.playerId, 1, COUNTER_LIMIT - 1, "pickup player");
    integer(actor.slot, 0, 3, "pickup player slot");
    integer(actor.weapon.ammo, 0, 65535, "pickup player ammunition");
    if (playerIds.has(actor.playerId) || slots.has(actor.slot))
      throw new Error("Duplicate pickup player");
    playerIds.add(actor.playerId);
    slots.add(actor.slot);
  }
  validateWeaponPickups(current, defs, catalog, playerIds);
  for (const surface of terrain) validateSweepTarget(surface);
  const tick = integer(current.tick + 1, 1, COUNTER_LIMIT - 1, "next pickup tick");
  const state = structuredClone(current),
    players = structuredClone([...actors]);
  const byId = new Map(defs.map((def) => [def.id, def]));
  const candidates: Array<{
    item: WeaponPickupState["items"][number];
    def: WeaponPickupDefinition;
    player: ControlledActor;
    time: Fraction;
  }> = [];
  const contacts: WeaponPickupState["contacts"] = [];
  state.tick = tick;
  for (const item of state.items) {
    if (item.status !== "available" && item.status !== "dormant") continue;
    const def = byId.get(item.id);
    if (!def) throw new Error("Missing pickup content");
    if (tick < def.activationTick) continue;
    if (tick >= def.expiresTick || !supported(def, terrain)) {
      item.status = tick >= def.expiresTick ? "expired" : "unsupported";
      item.resolvedTick = tick;
      continue;
    }
    item.status = "available";
    for (const player of players) {
      if (
        player.life !== "alive" ||
        player.bodyPresence !== "present" ||
        player.vehicleId !== null ||
        ["enter", "exit", "hurt"].includes(player.action.kind)
      )
        continue;
      const movement = movements.get(player.playerId);
      if (!movement) continue;
      const time = firstContact(movement, def.rect);
      const end = movement.rect;
      if (
        time &&
        end.x <= def.rect.x + def.rect.w &&
        end.x + end.w >= def.rect.x &&
        end.y <= def.rect.y + def.rect.h &&
        end.y + end.h >= def.rect.y
      )
        contacts.push({ id: def.id, playerId: player.playerId });
      if (
        time &&
        !current.contacts.some(
          (contact) => contact.id === def.id && contact.playerId === player.playerId,
        )
      )
        candidates.push({ item, def, player, time });
    }
  }
  candidates.sort(
    (a, b) =>
      compare(a.time, b.time) || a.player.slot - b.player.slot || a.def.claimId - b.def.claimId,
  );
  const claims: WeaponPickupClaim[] = [];
  for (const { item, def, player } of candidates) {
    if (item.status !== "available") continue;
    const claim = grant(player, def, tick);
    if (!claim) continue;
    item.status = "claimed";
    item.resolvedTick = tick;
    item.claimedBy = player.playerId;
    claims.push(claim);
  }
  state.contacts = contacts
    .filter((contact) =>
      state.items.some((item) => item.id === contact.id && item.status === "available"),
    )
    .sort((a, b) => a.id - b.id || a.playerId - b.playerId);
  validateWeaponPickups(state, defs, catalog, playerIds);
  return { state, players, claims };
}
