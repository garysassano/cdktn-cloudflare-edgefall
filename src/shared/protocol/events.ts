import { type BeamGeometry, type BeamProfile, beamSegments } from "../../game/combat/beam.js";
import type { WeaponPickupClaim, WeaponPickupDefinition } from "../../game/combat/pickups.js";
import { COUNTER_LIMIT, MAX_POSITION, integer } from "../../game/core/numeric.js";
import { Reader, Writer } from "./binary.js";
import { WEAPONS } from "./controller-record.js";
import { MAGIC, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./limits.js";
import { type InputIdentity, ProtocolError } from "./schema.js";

export const EVENT_CAPABILITY = 2;
export const EVENT_TYPE = 3;
export const EVENT_HEADER_BYTES = 32;
export const EVENT_RECORD_BYTES = 96;
export const MAX_EVENT_BATCH = 64;
export const MAX_EVENT_HISTORY = 512;
export const EVENT_HISTORY_TICKS = 120;
export const EVENT_KINDS = [
  "shot",
  "sound",
  "muzzle-blocked",
  "impact",
  "killed",
  "melee",
  "throw",
  "action-sound",
  "explosion",
  "shield-break",
  "prop-destroyed",
  "pickup",
] as const;
export const EVENT_MATERIALS = ["none", "terrain", "shield", "body"] as const;
export const EVENT_ORIGINS = ["player", "enemy"] as const;

export interface ActionConfirmationKey {
  playerId: number;
  controlEpoch: number;
  /** Monotonic per player/run, including held-fire actions; never a global action allocator. */
  shotOrdinal: number;
}
export interface GameplayEvent {
  kind: (typeof EVENT_KINDS)[number];
  origin: (typeof EVENT_ORIGINS)[number];
  ownerId: number;
  actionInstanceId: number;
  markerIndex: number;
  definitionId: number;
  x: number;
  y: number;
  targetId: number | null;
  material: (typeof EVENT_MATERIALS)[number];
  confirmation: ActionConfirmationKey | null;
  /** Acknowledged birth geometry survives short taps and dropped live snapshots. */
  beam: BeamGeometry | null;
  pickup: Pick<
    WeaponPickupClaim,
    "claimId" | "weaponId" | "previousWeaponId" | "previousAmmo" | "ammo"
  > | null;
}
export interface EventEnvelope {
  cursor: number;
  tick: number;
  counter: number;
  event: GameplayEvent;
}
export interface EventBatch extends InputIdentity {
  throughTick: number;
  events: EventEnvelope[];
}
export interface EventContext extends InputIdentity {
  attackIds: ReadonlySet<number>;
  soundIds: ReadonlySet<number>;
  beamProfiles: ReadonlyMap<number, Pick<BeamProfile, "range" | "width">>;
  pickupDefinitions: ReadonlyMap<number, WeaponPickupDefinition>;
}
export function eventCounter(value: number, zero = false): number {
  return integer(value, zero ? 0 : 1, COUNTER_LIMIT - 1, "event counter");
}
export function eventRequire(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ProtocolError("malformed", message);
}
function identity(value: InputIdentity, expected: InputIdentity) {
  eventCounter(value.runEpoch);
  eventCounter(value.connectionEpoch);
  if (value.runEpoch !== expected.runEpoch || value.connectionEpoch !== expected.connectionEpoch)
    throw new ProtocolError("identity-mismatch", "Event session mismatch");
}
export function validateGameplayEvent(event: GameplayEvent, context: EventContext): void {
  eventRequire(
    Object.keys(event).sort().join() ===
      "actionInstanceId,beam,confirmation,definitionId,kind,markerIndex,material,origin,ownerId,pickup,targetId,x,y",
    "Unexpected gameplay event fields",
  );
  eventRequire(EVENT_KINDS.includes(event.kind), "Unknown gameplay event kind");
  eventRequire(EVENT_ORIGINS.includes(event.origin), "Unknown event origin");
  eventRequire(EVENT_MATERIALS.includes(event.material), "Unknown impact material");
  eventCounter(event.ownerId);
  eventCounter(event.actionInstanceId, event.kind === "pickup");
  integer(event.markerIndex, 0, MAX_EVENT_HISTORY - 1, "event marker");
  eventCounter(event.definitionId);
  integer(event.x, -MAX_POSITION, MAX_POSITION, "event x");
  integer(event.y, -MAX_POSITION, MAX_POSITION, "event y");
  if (event.kind === "pickup") {
    const def = event.targetId === null ? undefined : context.pickupDefinitions.get(event.targetId);
    const grant = event.pickup;
    eventRequire(def !== undefined && grant !== null, "Unknown or missing pickup grant");
    eventRequire(
      Object.keys(grant).sort().join() === "ammo,claimId,previousAmmo,previousWeaponId,weaponId",
      "Unexpected pickup grant fields",
    );
    integer(grant.previousAmmo, 0, 65535, "previous pickup ammunition");
    eventRequire(
      grant.previousWeaponId !== "sidearm" || grant.previousAmmo === 0,
      "Sidearm pickup ammunition",
    );
    integer(grant.ammo, 0, def.ammoLimit, "granted ammunition");
    eventRequire(
      WEAPONS.includes(grant.previousWeaponId) &&
        grant.weaponId === def.weaponId &&
        grant.claimId === def.claimId,
      "Pickup content identity",
    );
    eventRequire(
      event.origin === "player" &&
        event.actionInstanceId === 0 &&
        event.markerIndex === 0 &&
        event.definitionId === def.sourceId &&
        event.confirmation === null &&
        event.beam === null &&
        event.material === "none",
      "Pickup event attribution",
    );
    eventRequire(event.x === def.rect.x && event.y === def.rect.y, "Pickup event location");
    eventRequire(
      grant.previousWeaponId === grant.weaponId
        ? grant.ammo === Math.min(def.ammoLimit, grant.previousAmmo + def.ammo) &&
            grant.ammo > grant.previousAmmo
        : grant.ammo === def.ammo,
      "Pickup inventory grant",
    );
    return;
  }
  eventRequire(event.pickup === null, "Unexpected pickup grant");
  eventRequire(
    (["sound", "action-sound"].includes(event.kind) ? context.soundIds : context.attackIds).has(
      event.definitionId,
    ),
    "Unknown event content definition",
  );
  integer(event.x, -MAX_POSITION, MAX_POSITION, "event x");
  integer(event.y, -MAX_POSITION, MAX_POSITION, "event y");
  const beamProfile = context.beamProfiles.get(event.definitionId);
  eventRequire(
    (event.beam !== null) === (event.kind === "shot" && beamProfile !== undefined),
    "Invalid beam event geometry presence",
  );
  if (event.beam !== null) {
    eventRequire(
      event.beam.width === beamProfile?.width && event.beam.length <= beamProfile.range,
      "Beam event disagrees with content profile",
    );
    eventRequire(
      Object.keys(event.beam).sort().join() === "heading,length,width",
      "Unexpected beam geometry fields",
    );
    beamSegments(
      { x: event.x, y: event.y },
      event.beam.heading,
      event.beam.length,
      event.beam.width,
    );
  }
  if (event.targetId !== null) eventCounter(event.targetId);
  const firearm = ["shot", "sound", "muzzle-blocked"].includes(event.kind);
  if (firearm) {
    if (event.origin === "player") {
      eventRequire(event.confirmation !== null, "Missing firearm confirmation identity");
      eventRequire(
        Object.keys(event.confirmation).sort().join() === "controlEpoch,playerId,shotOrdinal",
        "Unexpected confirmation fields",
      );
      eventCounter(event.confirmation.playerId);
      eventCounter(event.confirmation.controlEpoch);
      eventCounter(event.confirmation.shotOrdinal);
      eventRequire(event.confirmation.playerId === event.ownerId, "Confirmation owner mismatch");
    } else eventRequire(event.confirmation === null, "Enemy event has player confirmation");
    eventRequire(event.targetId === null, "Unexpected firearm target");
    eventRequire(
      event.material === (event.kind === "muzzle-blocked" ? "terrain" : "none"),
      "Invalid firearm material",
    );
  } else if (["melee", "throw", "action-sound", "explosion"].includes(event.kind)) {
    eventRequire(
      event.confirmation === null && event.targetId === null && event.material === "none",
      "Invalid foot action event",
    );
  } else {
    eventRequire(
      event.confirmation === null && event.material !== "none",
      "Invalid impact confirmation/material",
    );
    eventRequire(
      event.material === "terrain" ? event.targetId === null : event.targetId !== null,
      "Invalid impact target",
    );
    if (event.kind === "killed") eventRequire(event.material === "body", "Invalid kill material");
    if (event.kind === "prop-destroyed")
      eventRequire(event.material === "body", "Invalid prop destruction material");
    if (event.kind === "shield-break")
      eventRequire(event.material === "shield", "Invalid shield break material");
  }
}
export function followsEvent(previous: EventEnvelope, next: EventEnvelope): boolean {
  return (
    next.cursor === previous.cursor + 1 &&
    ((next.tick === previous.tick && next.counter === previous.counter + 1) ||
      (next.tick > previous.tick && next.counter === 0))
  );
}
export function validateEventBatch(batch: EventBatch, context: EventContext): void {
  identity(batch, context);
  eventCounter(batch.throughTick, true);
  eventRequire(
    Array.isArray(batch.events) &&
      batch.events.length > 0 &&
      batch.events.length <= MAX_EVENT_BATCH,
    "Invalid event batch count",
  );
  let previous: EventEnvelope | undefined;
  for (const envelope of batch.events) {
    eventCounter(envelope.cursor);
    eventCounter(envelope.tick, true);
    integer(envelope.counter, 0, MAX_EVENT_HISTORY - 1, "event identity counter");
    eventRequire(envelope.tick <= batch.throughTick, "Event beyond committed boundary");
    if (previous)
      eventRequire(followsEvent(previous, envelope), "Noncontiguous event identities/cursors");
    validateGameplayEvent(envelope.event, context);
    if (envelope.event.kind === "pickup") {
      const def = context.pickupDefinitions.get(envelope.event.targetId ?? 0);
      eventRequire(
        def !== undefined && envelope.tick >= def.activationTick && envelope.tick < def.expiresTick,
        "Pickup event lifetime",
      );
    }
    previous = envelope;
  }
}
export function encodeEventBatch(batch: EventBatch, context: EventContext): Uint8Array {
  validateEventBatch(batch, context);
  const length = EVENT_HEADER_BYTES + batch.events.length * EVENT_RECORD_BYTES;
  const w = new Writer(length);
  w.u16(MAGIC);
  w.u8(PROTOCOL_MAJOR);
  w.u8(PROTOCOL_MINOR);
  w.u8(EVENT_TYPE);
  w.zero(1);
  w.u16(length);
  w.u32(batch.runEpoch);
  w.u32(batch.connectionEpoch);
  w.u32(batch.throughTick);
  w.u32(batch.events[0]?.cursor ?? 0);
  w.u16(batch.events.length);
  w.u16(EVENT_RECORD_BYTES);
  w.zero(4);
  for (const { cursor, tick, counter, event } of batch.events) {
    w.u32(cursor);
    w.u32(tick);
    w.u32(counter);
    w.choice(EVENT_KINDS, event.kind);
    w.choice(EVENT_ORIGINS, event.origin);
    w.u32(event.ownerId);
    w.u32(event.actionInstanceId);
    w.u32(event.markerIndex);
    w.u32(event.definitionId);
    w.i32(event.x, MAX_POSITION);
    w.i32(event.y, MAX_POSITION);
    w.optionalId(event.targetId);
    w.choice(EVENT_MATERIALS, event.material);
    w.u32(event.confirmation?.playerId ?? 0);
    w.u32(event.confirmation?.controlEpoch ?? 0);
    w.u32(event.confirmation?.shotOrdinal ?? 0);
    w.u32(event.beam?.length ?? 0);
    w.u32(event.beam?.width ?? 0);
    w.u32(event.beam?.heading ?? 0);
    w.u32(event.pickup?.claimId ?? 0);
    w.u32(event.pickup ? WEAPONS.indexOf(event.pickup.weaponId) + 1 : 0, 0, WEAPONS.length);
    w.u32(event.pickup ? WEAPONS.indexOf(event.pickup.previousWeaponId) + 1 : 0, 0, WEAPONS.length);
    w.u32(event.pickup?.previousAmmo ?? 0, 0, 65535);
    w.u32(event.pickup?.ammo ?? 0, 0, 65535);
  }
  eventRequire(w.offset === length, "Event writer size mismatch");
  return w.bytes;
}
export function decodeEventBatch(bytes: Uint8Array, context: EventContext): EventBatch {
  eventRequire(
    bytes.byteLength >= EVENT_HEADER_BYTES + EVENT_RECORD_BYTES &&
      bytes.byteLength <= EVENT_HEADER_BYTES + MAX_EVENT_BATCH * EVENT_RECORD_BYTES,
    "Invalid event frame length",
  );
  const r = new Reader(bytes);
  eventRequire(
    r.u16() === MAGIC &&
      r.u8() === PROTOCOL_MAJOR &&
      r.u8() === PROTOCOL_MINOR &&
      r.u8() === EVENT_TYPE,
    "Invalid event header",
  );
  r.zero(1);
  eventRequire(r.u16() === bytes.byteLength, "Event length mismatch");
  const batch: EventBatch = {
    runEpoch: r.u32(1),
    connectionEpoch: r.u32(1),
    throughTick: r.u32(),
    events: [],
  };
  const firstCursor = r.u32(1),
    count = r.u16();
  eventRequire(
    count > 0 &&
      count <= MAX_EVENT_BATCH &&
      r.u16() === EVENT_RECORD_BYTES &&
      bytes.byteLength === EVENT_HEADER_BYTES + count * EVENT_RECORD_BYTES,
    "Invalid event record layout",
  );
  r.zero(4);
  for (let index = 0; index < count; index++) {
    const cursor = r.u32(1),
      tick = r.u32(),
      counter = r.u32(0, MAX_EVENT_HISTORY - 1);
    const event: GameplayEvent = {
      kind: r.choice(EVENT_KINDS),
      origin: r.choice(EVENT_ORIGINS),
      ownerId: r.u32(1),
      actionInstanceId: r.u32(),
      markerIndex: r.u32(0, MAX_EVENT_HISTORY - 1),
      definitionId: r.u32(1),
      x: r.i32(MAX_POSITION),
      y: r.i32(MAX_POSITION),
      targetId: r.u32() || null,
      material: r.choice(EVENT_MATERIALS),
      confirmation: null,
      beam: null,
      pickup: null,
    };
    const playerId = r.u32(),
      controlEpoch = r.u32(),
      shotOrdinal = r.u32();
    eventRequire(
      Boolean(playerId) === Boolean(controlEpoch) && Boolean(playerId) === Boolean(shotOrdinal),
      "Partial confirmation identity",
    );
    if (playerId) event.confirmation = { playerId, controlEpoch, shotOrdinal };
    const length = r.u32(),
      width = r.u32(),
      heading = r.u32(0, 3);
    eventRequire(width !== 0 || (length === 0 && heading === 0), "Partial beam geometry");
    if (width) event.beam = { length, width, heading: heading as BeamGeometry["heading"] };
    const claimId = r.u32(),
      weapon = r.u32(0, WEAPONS.length),
      previousWeapon = r.u32(0, WEAPONS.length),
      previousAmmo = r.u32(0, 65535),
      ammo = r.u32(0, 65535);
    eventRequire(
      claimId
        ? weapon > 0 && previousWeapon > 0
        : weapon === 0 && previousWeapon === 0 && previousAmmo === 0 && ammo === 0,
      "Partial pickup grant",
    );
    if (claimId) {
      const weaponId = WEAPONS[weapon - 1],
        previousWeaponId = WEAPONS[previousWeapon - 1];
      eventRequire(
        weaponId !== undefined && previousWeaponId !== undefined,
        "Unknown pickup weapon",
      );
      event.pickup = {
        claimId,
        weaponId,
        previousWeaponId,
        previousAmmo,
        ammo,
      };
    }
    batch.events.push({ cursor, tick, counter, event });
  }
  eventRequire(batch.events[0]?.cursor === firstCursor, "Event prefix mismatch");
  validateEventBatch(batch, context);
  return batch;
}

export interface EventBaseline extends InputIdentity {
  type: "resync-required";
  scope: "events";
  reason: "history-expired" | "client-gap";
  snapshotId: number;
  tick: number;
  baselineEventCursor: number;
}
export interface EventResyncRequest extends InputIdentity {
  type: "event-resync-request";
  lastEventCursor: number;
}
function controlObject(raw: string, fields: string[]): Record<string, unknown> {
  eventRequire(new TextEncoder().encode(raw).byteLength <= 512, "Event control too large");
  const data: unknown = JSON.parse(raw);
  eventRequire(
    Boolean(data) && typeof data === "object" && !Array.isArray(data),
    "Invalid event control",
  );
  eventRequire(
    Object.keys(data as object)
      .sort()
      .join() === fields.sort().join(),
    "Unexpected event control fields",
  );
  return data as Record<string, unknown>;
}
export function decodeEventBaseline(raw: string, context: InputIdentity): EventBaseline {
  const data = controlObject(raw, [
    "type",
    "scope",
    "reason",
    "runEpoch",
    "connectionEpoch",
    "snapshotId",
    "tick",
    "baselineEventCursor",
  ]) as unknown as EventBaseline;
  identity(data, context);
  eventCounter(data.snapshotId);
  eventCounter(data.tick, true);
  eventCounter(data.baselineEventCursor, true);
  eventRequire(
    data.type === "resync-required" &&
      data.scope === "events" &&
      ["history-expired", "client-gap"].includes(data.reason),
    "Invalid event baseline control",
  );
  return data;
}
export function decodeEventResyncRequest(raw: string, context: InputIdentity): EventResyncRequest {
  const data = controlObject(raw, [
    "type",
    "runEpoch",
    "connectionEpoch",
    "lastEventCursor",
  ]) as unknown as EventResyncRequest;
  identity(data, context);
  eventCounter(data.lastEventCursor, true);
  eventRequire(data.type === "event-resync-request", "Invalid event resync request");
  return data;
}
