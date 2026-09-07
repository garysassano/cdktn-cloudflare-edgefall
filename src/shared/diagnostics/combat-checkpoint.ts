import { validateRifleState } from "../../game/actors/rifle.js";
import { validateShield } from "../../game/actors/shield.js";
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
import {
  COMBAT_ATTACKS,
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  FOOT_ACTION_PROFILES,
  GRENADE_PROFILE,
  RIFLE_PROFILE,
  SHIELD_PROFILE,
} from "../../game/labs/combat-content.js";
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
    "format scenario tick nextActionId nextEntityId eventSequence players targets projectiles strikes grenades encounter events",
  );
  check(combat.format === 3, "simulation format");
  integer(combat.tick, 0, COMBAT_LAB_LIMIT, "combat checkpoint tick");
  integer(combat.players.length, 1, 4, "combat checkpoint players");
  integer(combat.projectiles.length, 0, 256, "combat checkpoint projectiles");
  integer(combat.strikes.length, 0, 4, "combat checkpoint strikes");
  integer(combat.grenades.length, 0, 32, "combat checkpoint grenades");
  integer(
    combat.projectiles.length + combat.strikes.length + combat.grenades.length,
    0,
    256,
    "attack entity budget",
  );
  integer(combat.events.length, 0, MAX_EVENT_HISTORY, "combat checkpoint notices");
  const initial = createCombatLab(combat.scenario, combat.players.length);
  const actionOwners = new Map<number, number>();
  const ownAction = (actionId: number, ownerId: number) => {
    integer(actionId, 0, combat.nextActionId - 1, "action allocation");
    if (actionId === 0) return;
    const owner = actionOwners.get(actionId);
    check(owner === undefined || owner === ownerId, "action owner collision");
    actionOwners.set(actionId, ownerId);
  };
  check(combat.targets.length === initial.targets.length, "target roster");
  const lifecycle = new EncounterLifecycle(combatEncounterDefinition(combat));
  lifecycle.restore(combat.encounter);
  check(
    combat.encounter.tick === combat.tick &&
      combat.eventSequence === combat.encounter.receipts.length,
    "ledger boundary",
  );
  for (const [index, actor] of combat.players.entries()) {
    ownAction(actor.action.actionInstanceId, actor.playerId);
    ownAction(actor.weapon.lastActionInstanceId, actor.playerId);
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
        ["fire", "melee", "grenade"].includes(actor.action.kind) &&
          timeline &&
          age >= 0 &&
          age < timeline.durationTicks &&
          actor.action.nextMarkerIndex ===
            timeline.markers.filter((marker) => marker.tickOffset <= age).length,
        "action marker cursor",
      );
      if (actor.action.kind === "melee" || actor.action.kind === "grenade")
        check(
          FOOT_ACTION_PROFILES[actor.action.kind].timelineIds.includes(actor.action.definitionId),
          "foot action timeline",
        );
    }
  }
  for (const [index, target] of combat.targets.entries()) {
    fields(target, "enemy health shield rifle guard");
    fields(target.enemy, "body facing geometryRevision life removalReason turns");
    const original = initial.targets[index],
      member = combat.encounter.members[index],
      body = target.enemy.body;
    check(
      original && member && body.id === member.id && target.shield === original.shield,
      "target identity",
    );
    integer(target.health, 0, 1, "target health");
    check(
      (target.rifle !== null) === (original.rifle !== null) &&
        (target.guard !== null) === (original.guard !== null),
      "enemy attack policy",
    );
    if (target.guard) {
      const guard = target.guard;
      fields(guard, "phase integrity facing turnFacing targetId action hitIds");
      fields(guard.action, "actionInstanceId stateStartTick definitionId nextMarkerIndex");
      check(
        guard.action.actionInstanceId !== 0 || member.status === "pending",
        "unstarted shield action",
      );
      ownAction(guard.action.actionInstanceId, body.id);
      validateShield(
        guard,
        target.enemy,
        combat.tick,
        combat.nextActionId,
        combat.players,
        COMBAT_CATALOG,
        SHIELD_PROFILE,
      );
    }
    if (target.rifle) {
      ownAction(target.rifle.action.actionInstanceId, target.enemy.body.id);
      fields(target.rifle, "action targetId aim facing");
      fields(
        target.rifle.action,
        "kind actionInstanceId stateStartTick definitionId nextMarkerIndex",
      );
      validateRifleState(
        target.rifle,
        target.enemy,
        combat.tick,
        combat.nextActionId,
        combat.players,
        COMBAT_CATALOG,
        RIFLE_PROFILE,
      );
    }
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
    ownAction(projectile.actionInstanceId, projectile.ownerId);
    fields(projectile, "id ownerId team actionInstanceId definitionId position velocity spawnTick");
    fields(projectile.position, "x y");
    fields(projectile.velocity, "x y");
    const attack = COMBAT_ATTACKS.get(projectile.definitionId);
    check(
      attack &&
        attack.kind === "swept-projectile" &&
        attack.material === "bullet" &&
        ((projectile.team === 1 &&
          combat.players.some((p) => p.playerId === projectile.ownerId) &&
          projectile.definitionId !== 3) ||
          (projectile.team === 2 &&
            projectile.definitionId === 3 &&
            combat.targets.some((t) => t.rifle && t.enemy.body.id === projectile.ownerId))),
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
  const attackIds = new Set(combat.projectiles.map((projectile) => projectile.id));
  const ownAttack = (source: {
    id: number;
    ownerId: number;
    actionInstanceId: number;
    team: number;
  }) => {
    integer(source.id, 1, combat.nextEntityId - 1, "attack entity allocation");
    check(
      !attackIds.has(source.id) &&
        !combat.targets.some((target) => target.enemy.body.id === source.id) &&
        !combat.players.some((player) => player.body.id === source.id),
      "attack entity collision",
    );
    attackIds.add(source.id);
    check(
      source.team === 1 && combat.players.some((player) => player.playerId === source.ownerId),
      "foot attack ownership",
    );
    ownAction(source.actionInstanceId, source.ownerId);
  };
  for (const strike of combat.strikes) {
    fields(strike, "id ownerId team actionInstanceId definitionId spawnTick endTick hitIds");
    ownAttack(strike);
    const owner = combat.players.find((player) => player.playerId === strike.ownerId);
    check(
      owner?.life === "alive" &&
        owner.action.kind === "melee" &&
        owner.action.actionInstanceId === strike.actionInstanceId &&
        strike.definitionId === 4 &&
        strike.spawnTick ===
          owner.action.stateStartTick +
            (COMBAT_CATALOG.timelines
              .get(owner.action.definitionId)
              ?.markers.find((marker) => marker.kind === "activate-hitbox")?.tickOffset ?? -1) &&
        strike.spawnTick <= combat.tick &&
        strike.endTick === strike.spawnTick + (COMBAT_ATTACKS.get(4)?.lifetimeTicks ?? 0) &&
        combat.tick < strike.endTick,
      "active melee continuation",
    );
    integer(strike.hitIds.length, 0, COMBAT_ATTACKS.get(4)?.maxTargets ?? 0, "melee hit budget");
    for (const [index, id] of strike.hitIds.entries())
      check(
        (index === 0 || id > (strike.hitIds[index - 1] ?? 0)) &&
          combat.targets.some((target) => target.enemy.body.id === id),
        "melee hit ledger",
      );
  }
  for (const grenade of combat.grenades) {
    fields(grenade, "id ownerId team actionInstanceId definitionId body spawnTick bounces");
    ownAttack(grenade);
    check(
      grenade.definitionId === 5 &&
        grenade.body.id === grenade.id &&
        grenade.body.shapeId === GRENADE_PROFILE.bodyShapeId,
      "grenade body/definition",
    );
    integer(
      grenade.spawnTick,
      Math.max(1, combat.tick - GRENADE_PROFILE.fuseTicks + 1),
      combat.tick,
      "grenade fuse continuation",
    );
    integer(grenade.bounces, 0, GRENADE_PROFILE.maximumBounces, "grenade bounce count");
    const writer = new Writer(BODY_BYTES);
    writeBody(writer, grenade.body);
    check(
      canonical(readBody(new Reader(writer.bytes))) === canonical(grenade.body),
      "grenade body schema",
    );
    integer(
      grenade.body.vx,
      -GRENADE_PROFILE.crouchedVelocity.x,
      GRENADE_PROFILE.crouchedVelocity.x,
      "grenade horizontal motion",
    );
    integer(
      grenade.body.vy,
      -GRENADE_PROFILE.terminalVelocity,
      GRENADE_PROFILE.terminalVelocity,
      "grenade vertical motion",
    );
  }
  for (const notice of combat.events) {
    ownAction(notice.actionInstanceId, notice.ownerId);
    fields(notice, "kind ownerId actionInstanceId markerIndex source position impact targetId");
    fields(notice.position, "x y");
    check(
      [
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
      ].includes(notice.kind),
      "notice kind",
    );
    check(
      combat.players.some((p) => p.playerId === notice.ownerId) ||
        combat.targets.some((t) => (t.rifle || t.guard) && t.enemy.body.id === notice.ownerId),
      "notice owner",
    );
    integer(notice.actionInstanceId, 1, combat.nextActionId - 1, "notice action");
    integer(notice.markerIndex, 0, 127, "notice marker");
    integer(notice.position.x, -MAX_POSITION, MAX_POSITION, "notice x");
    integer(notice.position.y, -MAX_POSITION, MAX_POSITION, "notice y");
    check(
      notice.targetId === null ||
        combat.targets.some((t) => t.enemy.body.id === notice.targetId) ||
        combat.players.some((p) => p.body.id === notice.targetId),
      "notice target",
    );
    check(
      ["impact", "killed", "shield-break"].includes(notice.kind) === (notice.impact !== null),
      "notice impact",
    );
    check((notice.impact === null) === (notice.source !== null), "notice source kind");
    if (notice.source !== null) {
      if ("controlEpoch" in notice.source) {
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
      } else if ("timelineId" in notice.source) {
        fields(notice.source, "definitionId timelineId stateStartTick");
        const enemy = combat.targets.find((target) => target.enemy.body.id === notice.ownerId);
        const player = combat.players.find((player) => player.playerId === notice.ownerId);
        check(
          enemy?.rifle
            ? enemy.rifle.action.actionInstanceId === notice.actionInstanceId &&
                enemy.rifle.action.definitionId === notice.source.timelineId &&
                notice.source.definitionId === 3
            : enemy?.guard
              ? enemy.guard.action.actionInstanceId === notice.actionInstanceId &&
                enemy.guard.action.definitionId === notice.source.timelineId &&
                enemy.guard.action.stateStartTick === notice.source.stateStartTick
              : player &&
                [4, 5].includes(notice.source.definitionId) &&
                (player.life === "death" ||
                  player.action.actionInstanceId === notice.actionInstanceId),
          "timeline notice owner",
        );
        const marker = COMBAT_CATALOG.timelines.get(notice.source.timelineId)?.markers[
          notice.markerIndex
        ];
        check(
          marker &&
            marker.tickOffset === combat.tick - notice.source.stateStartTick &&
            marker.payloadId === notice.source.definitionId &&
            marker.kind ===
              (["sound", "action-sound"].includes(notice.kind)
                ? "sound"
                : notice.kind === "melee"
                  ? "activate-hitbox"
                  : "spawn-attack"),
          "timeline notice marker",
        );
      } else {
        fields(notice.source, "definitionId spawnTick sourceId");
        check(
          notice.kind === "explosion" &&
            notice.source.definitionId === 5 &&
            notice.source.spawnTick === combat.tick - GRENADE_PROFILE.fuseTicks,
          "detonation fuse boundary",
        );
        integer(notice.source.sourceId, 1, combat.nextEntityId - 1, "detonation source");
      }
      if (!("spawnTick" in notice.source))
        check(
          [...COMBAT_CATALOG.timelines.values()].some((timeline) => {
            const marker = timeline.markers[notice.markerIndex];
            return (
              marker?.payloadId === notice.source?.definitionId &&
              marker?.kind ===
                (["sound", "action-sound"].includes(notice.kind)
                  ? "sound"
                  : notice.kind === "melee"
                    ? "activate-hitbox"
                    : "spawn-attack")
            );
          }),
          "notice marker payload",
        );
    }
    if (notice.impact !== null) {
      const impact = notice.impact;
      fields(
        impact,
        "sourceId definitionId actionInstanceId ownerId colliderId entityId kind damage position time",
      );
      fields(impact.time, "numerator denominator");
      fields(impact.position, "x y");
      integer(impact.sourceId, 1, combat.nextEntityId - 1, "impact projectile");
      check(COMBAT_ATTACKS.has(impact.definitionId), "impact definition");
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
      if (notice.kind === "shield-break") {
        const broken = combat.targets.find(
          (target) => target.enemy.body.id === notice.targetId,
        )?.guard;
        check(
          impact.kind === "shield" &&
            broken?.integrity === 0 &&
            broken.action.stateStartTick === combat.tick,
          "shield break attribution",
        );
      }
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
    const event = envelope.event;
    check(
      event.origin === "player"
        ? combat.players.some((player) => player.playerId === event.ownerId)
        : combat.targets.some(
            (target) => (target.rifle || target.guard) && target.enemy.body.id === event.ownerId,
          ),
      "retained event owner/origin",
    );
    ownAction(event.actionInstanceId, event.ownerId);
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
    format: 6,
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
    envelope.format === 6 &&
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
