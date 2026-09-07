import type { AreaExposure } from "../../game/combat/area-attack.js";
import { COUNTER_LIMIT, MAX_POSITION, MAX_SHAPE } from "../../game/core/numeric.js";
import type { Reader, Writer } from "./binary.js";
import { ProtocolError } from "./schema.js";
import type { CombatSnapshot, FullSnapshot } from "./snapshot-schema.js";

export const COMBAT_HEADER_BYTES = 48;
export const COMBAT_MEMBER_BYTES = 32;
export const AREA_EXPOSURE_BYTES = 48;
export const MAX_AREA_EXPOSURES = 64;
export const MAX_COMBAT_BYTES = 8784 + AREA_EXPOSURE_BYTES * MAX_AREA_EXPOSURES;
const PHASES = ["active", "complete", "retired", "failed"] as const;
const STATUSES = ["pending", "alive", "resolved"] as const;
const RESOLUTIONS = [
  "killed",
  "retreated",
  "crushed",
  "out-of-bounds",
  "ambient-timeout",
  "checkpoint-retired",
] as const;
const FAILURES = ["critical-loss", "forbidden-retreat", "invalid-pose"] as const;
const CAUSES = [
  "initial-overlap",
  "residual-overlap",
  "contact-limit",
  "unresolved-contact",
  "retreated",
  "crushed",
  "out-of-bounds",
] as const;

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ProtocolError("malformed", `Combat baseline: ${message}`);
}
function length(members: number, objectives: number, kills: number, volumes: number) {
  check(Number.isInteger(members) && members >= 0 && members <= 256, "member count");
  check(Number.isInteger(objectives) && objectives >= 0 && objectives <= 64, "objective count");
  check(Number.isInteger(kills) && kills >= 1 && kills <= 4, "participant count");
  check(
    Number.isInteger(volumes) && volumes >= 0 && volumes <= MAX_AREA_EXPOSURES,
    "area volume count",
  );
  return (
    COMBAT_HEADER_BYTES +
    members * COMBAT_MEMBER_BYTES +
    (objectives + kills) * 8 +
    volumes * AREA_EXPOSURE_BYTES
  );
}
export function combatRecordBytes(combat: CombatSnapshot | null) {
  return combat === null
    ? 0
    : length(
        combat.members.length,
        combat.objectives.length,
        combat.kills.length,
        combat.volumes.length,
      );
}
function writeTick(w: Writer, tick: number | null) {
  w.u32(tick === null ? 0 : tick + 1, tick === null ? 0 : 1);
}
function readTick(r: Reader): number | null {
  const value = r.u32();
  return value === 0 ? null : value - 1;
}
function writeOptional<T extends string>(w: Writer, values: readonly T[], value: T | null) {
  if (value !== null) check(values.includes(value), "unknown enum");
  w.u32(value === null ? 0 : values.indexOf(value) + 1, 0, values.length);
}
function readOptional<T extends string>(r: Reader, values: readonly T[]): T | null {
  const index = r.u32(0, values.length);
  return index === 0 ? null : (values[index - 1] ?? null);
}
export function writeCombat(w: Writer, combat: CombatSnapshot) {
  w.u16(2);
  w.u16(COMBAT_HEADER_BYTES);
  w.u32(combat.nextEntityId, 1);
  w.u32(combat.nextActionId, 1);
  w.u32(combat.encounterEventCursor, 0, 1024);
  w.u32(combat.encounterId, 1);
  w.choice(PHASES, combat.phase);
  w.u16(combat.members.length);
  w.u16(combat.objectives.length);
  w.u16(combat.kills.length);
  w.u16(combat.volumes.length);
  w.optionalId(combat.failure?.id ?? null);
  writeTick(w, combat.failure?.tick ?? null);
  writeOptional(w, FAILURES, combat.failure?.reason ?? null);
  writeOptional(w, CAUSES, combat.failure?.cause ?? null);
  for (const member of combat.members) {
    w.u32(member.id, 1);
    for (const flag of [member.required, member.critical, member.retreatAllowed])
      check(typeof flag === "boolean", "policy flag");
    w.u32(
      Number(member.required) |
        (Number(member.critical) << 1) |
        (Number(member.retreatAllowed) << 2),
      0,
      7,
    );
    w.choice(STATUSES, member.status);
    writeTick(w, member.activatedTick);
    writeTick(w, member.resolvedTick);
    writeOptional(w, RESOLUTIONS, member.reason);
    w.optionalId(member.killerId);
    w.zero(4);
  }
  for (const objective of combat.objectives) {
    w.u32(objective.id, 1);
    writeTick(w, objective.completedTick);
  }
  for (const credit of combat.kills) {
    w.u32(credit.playerId, 1);
    w.u32(credit.count, 0, 256);
  }
  for (const volume of combat.volumes) {
    for (const value of [
      volume.id,
      volume.ownerId,
      volume.actionInstanceId,
      volume.definitionId,
      volume.spawnTick,
      volume.endTick,
    ])
      w.u32(value, 1);
    w.i32(volume.rect.x, MAX_POSITION);
    w.i32(volume.rect.y, MAX_POSITION);
    w.u32(volume.rect.w, 1, MAX_SHAPE);
    w.u32(volume.rect.h, 1, MAX_SHAPE);
    w.u32(volume.heading, 0, 3);
    w.u16(volume.lobe);
    check(typeof volume.attached === "boolean", "area attachment flag");
    w.u16(Number(volume.attached));
  }
}
export function readCombat(r: Reader): CombatSnapshot {
  const start = r.offset;
  check(r.u16() === 2 && r.u16() === COMBAT_HEADER_BYTES, "section version/header");
  const cursors = {
    nextEntityId: r.u32(1),
    nextActionId: r.u32(1),
    encounterEventCursor: r.u32(0, 1024),
    encounterId: r.u32(1),
    phase: r.choice(PHASES),
  };
  const members = r.u16(),
    objectives = r.u16(),
    kills = r.u16(),
    volumes = r.u16();
  check(
    start + length(members, objectives, kills, volumes) === r.bytes.byteLength,
    "section length",
  );
  const id = r.u32() || null,
    tick = readTick(r),
    reason = readOptional(r, FAILURES),
    cause = readOptional(r, CAUSES);
  check(
    id === null
      ? tick === null && reason === null && cause === null
      : tick !== null && reason !== null && cause !== null,
    "partial failure",
  );
  const combat: CombatSnapshot = {
    ...cursors,
    failure:
      id !== null && tick !== null && reason !== null && cause !== null
        ? { id, tick, reason, cause }
        : null,
    members: [],
    objectives: [],
    kills: [],
    volumes: [],
  };
  for (let i = 0; i < members; i++) {
    const id = r.u32(1),
      flags = r.u32(0, 7);
    combat.members.push({
      id,
      required: Boolean(flags & 1),
      critical: Boolean(flags & 2),
      retreatAllowed: Boolean(flags & 4),
      status: r.choice(STATUSES),
      activatedTick: readTick(r),
      resolvedTick: readTick(r),
      reason: readOptional(r, RESOLUTIONS),
      killerId: r.u32() || null,
    });
    r.zero(4);
  }
  for (let i = 0; i < objectives; i++)
    combat.objectives.push({ id: r.u32(1), completedTick: readTick(r) });
  for (let i = 0; i < kills; i++) combat.kills.push({ playerId: r.u32(1), count: r.u32(0, 256) });
  for (let i = 0; i < volumes; i++) {
    const volume: AreaExposure = {
      id: r.u32(1),
      ownerId: r.u32(1),
      actionInstanceId: r.u32(1),
      definitionId: r.u32(1),
      spawnTick: r.u32(1),
      endTick: r.u32(1),
      rect: {
        x: r.i32(MAX_POSITION),
        y: r.i32(MAX_POSITION),
        w: r.u32(1, MAX_SHAPE),
        h: r.u32(1, MAX_SHAPE),
      },
      heading: r.u32(0, 3) as AreaExposure["heading"],
      lobe: r.u16(),
      attached: false,
    };
    const flag = r.u16();
    check(flag <= 1, "area attachment flag");
    volume.attached = flag === 1;
    combat.volumes.push(volume);
  }
  return combat;
}

export function validateCombat(snapshot: FullSnapshot) {
  const combat = snapshot.combat;
  if (combat === null) return;
  combatRecordBytes(combat);
  check(combat.encounterId === snapshot.campaign.encounterId, "encounter identity");
  function ordered(ids: number[]) {
    check(
      ids.every(
        (id, i) =>
          Number.isSafeInteger(id) &&
          id > 0 &&
          id < COUNTER_LIMIT &&
          (i === 0 || id > (ids[i - 1] ?? 0)),
      ),
      "unordered/duplicate IDs",
    );
  }
  ordered(combat.members.map((m) => m.id));
  ordered(combat.objectives.map((o) => o.id));
  ordered(combat.kills.map((k) => k.playerId));
  const participants = new Set(snapshot.players.map((p) => p.playerId));
  const areaOwners = new Map<number, string>();
  const areaActions = new Map<number, number>();
  for (const [index, volume] of combat.volumes.entries()) {
    const previous = combat.volumes[index - 1];
    check(
      !previous ||
        volume.id > previous.id ||
        (volume.id === previous.id && volume.lobe > previous.lobe),
      "unordered/duplicate area exposures",
    );
    check(
      participants.has(volume.ownerId) && volume.lobe >= 0 && volume.lobe < 4,
      "area owner/lobe",
    );
    check(
      volume.spawnTick <= snapshot.tick &&
        snapshot.tick < volume.endTick &&
        volume.endTick - volume.spawnTick <= 120,
      "area lifetime",
    );
    check(
      Math.abs(volume.rect.x + volume.rect.w) <= MAX_POSITION &&
        Math.abs(volume.rect.y + volume.rect.h) <= MAX_POSITION,
      "area endpoint bounds",
    );
    check(
      ![
        ...snapshot.players.map((p) => p.body.id),
        ...combat.members.map((m) => m.id),
        ...snapshot.removedIds,
        ...snapshot.enemies.map((e) => e.id),
        ...snapshot.projectiles.map((p) => p.id),
        ...snapshot.vehicles.map((v) => v.body.id),
        ...snapshot.platforms.map((p) => p.id),
      ].includes(volume.id),
      "area entity collision",
    );
    const owner = `${volume.ownerId}/${volume.actionInstanceId}/${volume.definitionId}`;
    check(
      !areaOwners.has(volume.id) || areaOwners.get(volume.id) === owner,
      "area source ownership",
    );
    areaOwners.set(volume.id, owner);
    check(
      !areaActions.has(volume.actionInstanceId) ||
        areaActions.get(volume.actionInstanceId) === volume.id,
      "duplicate area action",
    );
    areaActions.set(volume.actionInstanceId, volume.id);
  }
  check(
    combat.kills.length === participants.size &&
      combat.kills.every((k) => participants.has(k.playerId)),
    "participant roster",
  );
  function time(value: number | null) {
    check(
      value === null ||
        (Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= snapshot.tick &&
          value < COUNTER_LIMIT - 1),
      "future/invalid tick",
    );
  }
  for (const m of combat.members) {
    time(m.activatedTick);
    time(m.resolvedTick);
    check(!m.critical || (m.required && !m.retreatAllowed), "critical policy");
    check(
      (m.status === "resolved") === (m.reason !== null) &&
        (m.status === "resolved") === (m.resolvedTick !== null),
      "resolution state",
    );
    check(m.status !== "pending" || m.activatedTick === null, "pending activation");
    check(m.status !== "alive" || m.activatedTick !== null, "missing activation");
    check(
      m.status !== "resolved" || m.reason === "checkpoint-retired" || m.activatedTick !== null,
      "unactivated resolution",
    );
    check(
      m.activatedTick === null || m.resolvedTick === null || m.activatedTick <= m.resolvedTick,
      "resolution before activation",
    );
    check(
      m.killerId === null || (m.reason === "killed" && participants.has(m.killerId)),
      "kill attribution",
    );
    check(
      m.reason !== "ambient-timeout" || (!m.required && !m.critical),
      "required ambient cleanup",
    );
    check(m.reason !== "checkpoint-retired" || combat.phase === "retired", "retirement phase");
    check(
      m.status !== "resolved" || !snapshot.enemies.some((e) => e.id === m.id && e.health > 0),
      "resolved enemy still alive",
    );
  }
  for (const o of combat.objectives) time(o.completedTick);
  for (const k of combat.kills)
    check(
      k.count ===
        combat.members.filter((m) => m.reason === "killed" && m.killerId === k.playerId).length,
      "kill count mismatch",
    );
  const remaining =
    combat.phase === "retired"
      ? 0
      : combat.members.filter((m) => m.required && m.status !== "resolved").length +
        combat.objectives.filter((o) => o.completedTick === null).length;
  check(remaining === snapshot.campaign.remainingEnemies, "remaining count mismatch");
  check(combat.phase !== "complete" || remaining === 0, "premature completion");
  check(
    combat.phase !== "retired" || combat.members.every((m) => m.status === "resolved"),
    "incomplete retirement",
  );
  check((combat.phase === "failed") === (combat.failure !== null), "failure state");
  if (combat.failure !== null) {
    time(combat.failure.tick);
    check(
      combat.members.some((m) => m.id === combat.failure?.id),
      "unknown failure owner",
    );
  }
  const entityIds = [
    ...snapshot.players.map((p) => p.body.id),
    ...snapshot.vehicles.map((v) => v.body.id),
    ...snapshot.enemies.map((e) => e.id),
    ...snapshot.projectiles.flatMap((p) => [p.id, p.ownerId]),
    ...snapshot.platforms.map((p) => p.id),
    ...snapshot.threats.map((t) => t.sourceId),
    ...snapshot.removedIds,
    ...combat.members.map((m) => m.id),
    ...combat.volumes.map((volume) => volume.id),
  ];
  const actionIds = [
    ...snapshot.players.flatMap((p) => [p.action.actionInstanceId, p.weapon.lastActionInstanceId]),
    ...snapshot.vehicles.flatMap((v) => [v.action.actionInstanceId, v.weapon.lastActionInstanceId]),
    ...snapshot.enemies.map((e) => e.actionInstanceId),
    ...snapshot.projectiles.map((p) => p.actionInstanceId),
    ...snapshot.threats.map((t) => t.actionInstanceId),
    ...combat.volumes.map((volume) => volume.actionInstanceId),
  ];
  check(combat.nextEntityId > Math.max(0, ...entityIds), "entity allocator reused ID");
  check(combat.nextActionId > Math.max(0, ...actionIds), "action allocator reused ID");
}
