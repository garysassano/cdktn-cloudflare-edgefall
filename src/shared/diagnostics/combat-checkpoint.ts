import { validatePlayerLife } from "../../game/campaign/life.js";
import { canonical } from "../../game/core/canonical.js";
import { COUNTER_LIMIT, MAX_POSITION, integer } from "../../game/core/numeric.js";
import { EncounterLifecycle } from "../../game/encounters/lifecycle.js";
import {
  COMBAT_LAB_LIMIT,
  combatEncounterDefinition,
  createCombatLab,
} from "../../game/labs/combat.js";
import { validateCombatCampaign } from "../../game/labs/combat-campaign.js";
import { COMBAT_ATTACKS, COMBAT_CATALOG, COMBAT_SHAPES } from "../../game/labs/combat-content.js";
import type { GameIdentity } from "../content-id.js";
import { Reader, Writer } from "../protocol/binary.js";
import { readBody, writeBody } from "../protocol/controller-record.js";
import {
  EVENT_HISTORY_TICKS,
  MAX_EVENT_HISTORY,
  eventCounter,
  followsEvent,
  validateGameplayEvent,
} from "../protocol/events.js";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from "../protocol/limits.js";
import { decodeSnapshot, encodeSnapshot } from "../protocol/snapshot.js";
import { BODY_BYTES } from "../protocol/snapshot-schema.js";
import { isPausableRoom } from "../session/room-phase.js";
import { combatEventContext } from "./combat-events.js";
import {
  type CombatJournalTick,
  type CombatRuntime,
  combatRuntimeHash,
  replayCombatTick,
} from "./combat-runtime.js";
import { combatSnapshot } from "./combat-workload.js";
import { roomWorkloadHash } from "./room-workload.js";

export type CombatArchiveIdentity = Pick<
  GameIdentity,
  "simulationVersion" | "simulationBuild" | "contentFormat" | "contentHash"
> & { runId: string };
export const COMBAT_ARCHIVE_MAX_BYTES = 1024 * 1024;
export const COMBAT_SEGMENT_TICKS = 15;
export const COMBAT_CHECKPOINT_TICKS = 60;
export interface CombatJournalSegment {
  runEpoch: number;
  fromTick: number;
  throughTick: number;
  entries: CombatJournalTick[];
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Combat checkpoint: ${message}`);
}
function fields(value: object, names: string) {
  check(
    value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === names.split(" ").sort().join(","),
    "unexpected/missing fields",
  );
}
function identity(value: CombatArchiveIdentity) {
  fields(value, "simulationVersion simulationBuild contentFormat contentHash runId");
  integer(value.simulationVersion, 1, COUNTER_LIMIT - 1, "simulation version");
  integer(value.contentFormat, 1, COUNTER_LIMIT - 1, "content format");
  for (const digest of [value.simulationBuild, value.contentHash])
    check(typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest), "identity digest");
  check(typeof value.runId === "string" && /^[a-z0-9-]{8,80}$/u.test(value.runId), "run identity");
}

/** Validates the laboratory's full server continuation, including fields absent from the wire. */
export function validateCombatCheckpoint(state: CombatRuntime): void {
  fields(state, "combat snapshot history connectedPlayerIds pausedFrom campaign");
  const { combat, snapshot, history } = state;
  fields(state.campaign, "state continues");
  fields(
    state.campaign.state,
    "ruleset mission checkpointId encounterId continuesRemaining continuesUsed phase requiredEntities resolvedEntities",
  );
  for (const decision of state.campaign.continues) {
    fields(
      decision,
      "ordinal tick checkpointId fromRunEpoch runEpoch nextEntityIdBefore retiredEntityIds spawnedEntityIds kills",
    );
    for (const kill of decision.kills) fields(kill, "playerId count");
  }
  validateCombatCampaign(state.campaign, combat, snapshot.runEpoch);
  check(
    snapshot.roomMode === "paused-empty"
      ? state.pausedFrom !== null && isPausableRoom(state.pausedFrom)
      : state.pausedFrom === null,
    "paused room origin",
  );
  fields(
    combat,
    "format scenario tick nextActionId nextEntityId eventSequence players targets projectiles encounter events",
  );
  check(combat.format === 1, "simulation format");
  integer(combat.tick, 0, COMBAT_LAB_LIMIT, "combat checkpoint tick");
  integer(combat.players.length, 1, 4, "combat checkpoint players");
  integer(combat.projectiles.length, 0, 256, "combat checkpoint projectiles");
  integer(combat.events.length, 0, MAX_EVENT_HISTORY, "combat checkpoint notices");
  const initial = createCombatLab(combat.scenario, combat.players.length);
  check(combat.targets.length === initial.targets.length, "target roster");
  const lifecycle = new EncounterLifecycle(combatEncounterDefinition(combat));
  lifecycle.restore(combat.encounter);
  check(
    combat.encounter.tick === combat.tick &&
      combat.eventSequence === combat.encounter.receipts.length,
    "ledger boundary",
  );
  for (const [index, actor] of combat.players.entries()) {
    const original = initial.players[index];
    check(
      original &&
        actor.playerId === original.playerId &&
        actor.body.id === original.body.id &&
        actor.slot === original.slot,
      "player roster",
    );
    check(COMBAT_CATALOG.firearms.has(actor.weapon.id), "unsupported weapon");
    validatePlayerLife(actor, combat.tick, snapshot.campaign.ruleset);
    if (actor.action.kind !== "ready") {
      const timeline = COMBAT_CATALOG.timelines.get(actor.action.definitionId);
      const age = combat.tick - actor.action.stateStartTick;
      check(
        actor.action.kind === "fire" &&
          timeline &&
          age >= 0 &&
          age < timeline.durationTicks &&
          actor.action.nextMarkerIndex ===
            timeline.markers.filter((marker) => marker.tickOffset <= age).length,
        "action marker cursor",
      );
    }
  }
  for (const [index, target] of combat.targets.entries()) {
    fields(target, "enemy health shield");
    fields(target.enemy, "body facing geometryRevision life removalReason turns");
    const original = initial.targets[index],
      member = combat.encounter.members[index],
      body = target.enemy.body;
    check(
      original && member && body.id === member.id && target.shield === original.shield,
      "target identity",
    );
    integer(target.health, 0, 1, "target health");
    integer(target.enemy.turns, 0, combat.tick, "enemy turn cursor");
    check(
      (target.health === 0) === (target.enemy.life === "removed") &&
        ["alive", "removed"].includes(target.enemy.life),
      "enemy life",
    );
    check((target.health === 0) === (member.status === "resolved"), "enemy ledger resolution");
    check(
      target.enemy.removalReason === null ||
        (target.health === 0 &&
          ["crushed", "out-of-bounds"].includes(target.enemy.removalReason) &&
          member.reason === target.enemy.removalReason),
      "enemy removal cause",
    );
    check(
      target.enemy.geometryRevision === snapshot.geometryRevision &&
        [-1, 1].includes(target.enemy.facing),
      "enemy geometry/facing",
    );
    const writer = new Writer(BODY_BYTES);
    writeBody(writer, body);
    check(canonical(readBody(new Reader(writer.bytes))) === canonical(body), "body schema");
    check(
      COMBAT_SHAPES.has(body.shapeId) && body.grounded === (body.supportId !== null),
      "enemy support/shape",
    );
    const contacts = new Set<string>();
    for (const contact of body.contacts) {
      const key = `${contact.otherId}:${contact.normalX}:${contact.normalY}`;
      check(
        Math.abs(contact.normalX) + Math.abs(contact.normalY) === 1 &&
          contact.toiNumerator <= contact.toiDenominator &&
          !contacts.has(key),
        "enemy contacts",
      );
      contacts.add(key);
    }
  }
  for (const projectile of combat.projectiles) {
    fields(projectile, "id ownerId team actionInstanceId definitionId position velocity spawnTick");
    fields(projectile.position, "x y");
    fields(projectile.velocity, "x y");
    const attack = COMBAT_ATTACKS.get(projectile.definitionId);
    check(
      attack &&
        projectile.team === 1 &&
        combat.players.some((p) => p.playerId === projectile.ownerId),
      "projectile owner/definition",
    );
    check(
      projectile.spawnTick > 0 &&
        projectile.spawnTick <= combat.tick &&
        combat.tick - projectile.spawnTick < attack.lifetimeTicks,
      "projectile lifetime",
    );
    check(
      Math.abs(projectile.velocity.x) + Math.abs(projectile.velocity.y) === attack.speed,
      "projectile motion",
    );
  }
  for (const notice of combat.events) {
    fields(notice, "kind ownerId actionInstanceId markerIndex source position impact targetId");
    fields(notice.position, "x y");
    check(
      ["shot", "sound", "muzzle-blocked", "impact", "killed"].includes(notice.kind),
      "notice kind",
    );
    check(
      combat.players.some((p) => p.playerId === notice.ownerId),
      "notice owner",
    );
    integer(notice.actionInstanceId, 1, combat.nextActionId - 1, "notice action");
    integer(notice.markerIndex, 0, 127, "notice marker");
    integer(notice.position.x, -MAX_POSITION, MAX_POSITION, "notice x");
    integer(notice.position.y, -MAX_POSITION, MAX_POSITION, "notice y");
    check(
      notice.targetId === null || combat.targets.some((t) => t.enemy.body.id === notice.targetId),
      "notice target",
    );
    check(
      (notice.kind === "impact" || notice.kind === "killed") === (notice.impact !== null),
      "notice impact",
    );
    check((notice.impact === null) === (notice.source !== null), "notice source kind");
    if (notice.source !== null) {
      fields(notice.source, "definitionId controlEpoch shotOrdinal");
      const owner = combat.players.find((player) => player.playerId === notice.ownerId);
      check(
        owner &&
          owner.weapon.lastActionInstanceId === notice.actionInstanceId &&
          owner.weapon.shotOrdinal === notice.source.shotOrdinal &&
          owner.controlEpoch === notice.source.controlEpoch,
        "notice confirmation identity",
      );
      integer(notice.source.shotOrdinal, 1, COUNTER_LIMIT - 1, "notice shot ordinal");
      check(
        [...COMBAT_CATALOG.timelines.values()].some((timeline) => {
          const marker = timeline.markers[notice.markerIndex];
          return (
            marker?.payloadId === notice.source?.definitionId &&
            marker?.kind === (notice.kind === "sound" ? "sound" : "spawn-attack")
          );
        }),
        "notice marker payload",
      );
    }
    if (notice.impact !== null) {
      const impact = notice.impact;
      fields(
        impact,
        "projectileId actionInstanceId ownerId colliderId entityId kind damage position time",
      );
      fields(impact.time, "numerator denominator");
      fields(impact.position, "x y");
      integer(impact.projectileId, 1, combat.nextEntityId - 1, "impact projectile");
      integer(impact.colliderId, 1, COUNTER_LIMIT - 1, "impact collider");
      integer(impact.damage, 0, 65535, "impact damage");
      integer(impact.time.denominator, 1, 2 ** 17, "impact denominator");
      integer(impact.time.numerator, 0, impact.time.denominator, "impact numerator");
      check(
        impact.actionInstanceId === notice.actionInstanceId &&
          impact.ownerId === notice.ownerId &&
          impact.entityId === notice.targetId &&
          canonical(impact.position) === canonical(notice.position),
        "impact attribution",
      );
      check(
        ["terrain", "shield", "body"].includes(impact.kind) &&
          (impact.kind === "terrain") === (impact.entityId === null),
        "impact material",
      );
      check(notice.kind !== "killed" || impact.kind === "body", "kill material");
    }
  }
  const local = snapshot.acknowledgments.find(
    (a) => a.connectionEpoch === snapshot.connectionEpoch,
  );
  check(local, "checkpoint snapshot recipient");
  const context = {
    runEpoch: snapshot.runEpoch,
    connectionEpoch: snapshot.connectionEpoch,
    playerId: local.playerId,
    geometryRevision: snapshot.geometryRevision,
    shapeIds: new Set(COMBAT_SHAPES.keys()),
  };
  const restored = decodeSnapshot(encodeSnapshot(snapshot, context), context);
  check(
    canonical(restored) === canonical(snapshot) &&
      snapshot.stateHash === roomWorkloadHash(snapshot),
    "snapshot schema/hash",
  );
  check(
    canonical(combatSnapshot(combat, snapshot, state.campaign)) === canonical(snapshot),
    "combat/snapshot mismatch",
  );
  integer(state.connectedPlayerIds.length, 0, combat.players.length, "connected roster size");
  check(
    state.connectedPlayerIds.every(
      (id, i) =>
        combat.players.some((p) => p.playerId === id) &&
        (i === 0 || id > (state.connectedPlayerIds[i - 1] ?? 0)),
    ),
    "connected roster",
  );
  fields(history, "runEpoch tick cursor entries capEvictions ageEvictions");
  check(
    history.runEpoch === snapshot.runEpoch &&
      history.tick === combat.tick &&
      history.cursor === snapshot.baselineEventCursor,
    "event history boundary",
  );
  eventCounter(history.cursor, true);
  integer(history.entries.length, 0, MAX_EVENT_HISTORY, "retained event count");
  integer(history.capEvictions, 0, history.cursor, "event cap evictions");
  integer(history.ageEvictions, 0, history.cursor, "event age evictions");
  check(
    history.capEvictions + history.ageEvictions + history.entries.length === history.cursor,
    "event retention accounting",
  );
  for (const [index, envelope] of history.entries.entries()) {
    fields(envelope, "cursor tick counter event");
    eventCounter(envelope.cursor);
    integer(
      envelope.tick,
      Math.max(1, combat.tick - EVENT_HISTORY_TICKS + 1),
      combat.tick,
      "retained event tick",
    );
    integer(envelope.counter, 0, MAX_EVENT_HISTORY - 1, "retained event counter");
    check(
      envelope.cursor === history.cursor - history.entries.length + index + 1,
      "retained cursor gap",
    );
    const previous = history.entries[index - 1];
    check(!previous || followsEvent(previous, envelope), "event identity gap");
    validateGameplayEvent(envelope.event, combatEventContext(snapshot));
    check(envelope.event.actionInstanceId < combat.nextActionId, "future retained action");
  }
}

async function digest(payload: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function seal(
  kind: "checkpoint" | "journal",
  value: unknown,
  expected: CombatArchiveIdentity,
) {
  identity(expected);
  const payload = canonical(value);
  check(
    new TextEncoder().encode(payload).byteLength < COMBAT_ARCHIVE_MAX_BYTES / 2,
    "payload size limit",
  );
  return canonical({
    format: 3,
    protocolMajor: PROTOCOL_MAJOR,
    protocolMinor: PROTOCOL_MINOR,
    kind,
    identity: expected,
    payload,
    sha256: await digest(payload),
  });
}
async function unseal(
  raw: string,
  kind: "checkpoint" | "journal",
  expected: CombatArchiveIdentity,
): Promise<unknown> {
  identity(expected);
  check(
    typeof raw === "string" &&
      raw.length <= COMBAT_ARCHIVE_MAX_BYTES &&
      new TextEncoder().encode(raw).byteLength <= COMBAT_ARCHIVE_MAX_BYTES,
    "archive size limit",
  );
  const envelope = JSON.parse(raw);
  fields(envelope, "format protocolMajor protocolMinor kind identity payload sha256");
  check(
    envelope.format === 3 &&
      envelope.kind === kind &&
      envelope.protocolMajor === PROTOCOL_MAJOR &&
      envelope.protocolMinor === PROTOCOL_MINOR,
    "archive version/kind",
  );
  check(canonical(envelope.identity) === canonical(expected), "archive identity mismatch");
  check(
    typeof envelope.payload === "string" &&
      envelope.payload.length < COMBAT_ARCHIVE_MAX_BYTES / 2 &&
      (await digest(envelope.payload)) === envelope.sha256,
    "archive checksum mismatch",
  );
  const value: unknown = JSON.parse(envelope.payload);
  check(canonical(value) === envelope.payload, "noncanonical payload");
  return value;
}
/** Clone before the first await; later live mutations cannot change the captured boundary. */
export async function encodeCombatCheckpoint(
  current: CombatRuntime,
  expected: CombatArchiveIdentity,
): Promise<string> {
  const state = structuredClone(current);
  validateCombatCheckpoint(state);
  return seal("checkpoint", state, { ...expected });
}
export async function decodeCombatCheckpoint(
  raw: string,
  expected: CombatArchiveIdentity,
): Promise<CombatRuntime> {
  const state = (await unseal(raw, "checkpoint", expected)) as CombatRuntime;
  validateCombatCheckpoint(state);
  return state;
}
export async function encodeCombatJournalSegment(
  start: CombatRuntime,
  entries: readonly CombatJournalTick[],
  expected: CombatArchiveIdentity,
): Promise<string> {
  const saved = structuredClone([...entries]);
  integer(saved.length, 1, COMBAT_SEGMENT_TICKS, "journal segment ticks");
  let state = start;
  for (const entry of saved) state = replayCombatTick(state, entry);
  return encodeAcceptedCombatJournalSegment(start, saved, state, expected);
}
/**
 * Capture the already accepted authority transaction without re-running 15 ticks on its event loop.
 * Only the live coordinated commit may supply `accepted`; archives are always resimulated on load.
 */
export async function encodeAcceptedCombatJournalSegment(
  start: CombatRuntime,
  entries: readonly CombatJournalTick[],
  accepted: CombatRuntime,
  expected: CombatArchiveIdentity,
): Promise<string> {
  const saved = structuredClone([...entries]);
  integer(saved.length, 1, COMBAT_SEGMENT_TICKS, "journal segment ticks");
  let hash = combatRuntimeHash(start);
  for (const [index, entry] of saved.entries()) {
    check(
      entry.runEpoch === start.snapshot.runEpoch &&
        entry.tick === start.combat.tick + index + 1 &&
        entry.beforeHash === hash &&
        entry.assertions.length === 1 &&
        entry.assertions[0]?.kind === "state-hash" &&
        /^[a-f0-9]{8}$/u.test(entry.assertions[0].value),
      "accepted journal prefix",
    );
    hash = entry.assertions[0].value;
  }
  validateCombatCheckpoint(accepted);
  check(
    accepted.snapshot.runEpoch === start.snapshot.runEpoch &&
      accepted.combat.tick === start.combat.tick + saved.length &&
      combatRuntimeHash(accepted) === hash,
    "accepted journal boundary",
  );
  const segment: CombatJournalSegment = {
    runEpoch: start.snapshot.runEpoch,
    fromTick: start.combat.tick + 1,
    throughTick: accepted.combat.tick,
    entries: saved,
  };
  return seal("journal", segment, { ...expected });
}
export async function restoreCombatJournalSegment(
  start: CombatRuntime,
  raw: string,
  expected: CombatArchiveIdentity,
): Promise<CombatRuntime> {
  const segment = (await unseal(raw, "journal", expected)) as CombatJournalSegment;
  fields(segment, "runEpoch fromTick throughTick entries");
  integer(segment.entries.length, 1, COMBAT_SEGMENT_TICKS, "journal segment ticks");
  check(
    segment.runEpoch === start.snapshot.runEpoch &&
      segment.fromTick === start.combat.tick + 1 &&
      segment.throughTick === start.combat.tick + segment.entries.length,
    "journal segment gap/epoch",
  );
  let state = start;
  for (const entry of segment.entries) state = replayCombatTick(state, entry);
  validateCombatCheckpoint(state);
  return state;
}
