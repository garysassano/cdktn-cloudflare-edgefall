import { canonical } from "../core/canonical.js";
import { COUNTER_LIMIT, integer } from "../core/numeric.js";

export interface EncounterMember {
  id: number;
  required: boolean;
  critical: boolean;
  retreatAllowed: boolean;
  watchdogTicks: number;
  /** Only optional, noncritical ambient actors may be cleaned up automatically. */
  ambientCleanupTicks: number | null;
}
export interface EncounterDefinition {
  id: number;
  participants: number[];
  members: EncounterMember[];
  objectives: number[];
}
export type Resolution =
  | "killed"
  | "retreated"
  | "crushed"
  | "out-of-bounds"
  | "ambient-timeout"
  | "checkpoint-retired";
export type PoseFault =
  | "initial-overlap"
  | "residual-overlap"
  | "contact-limit"
  | "unresolved-contact";
const POSE_FAULTS = ["initial-overlap", "residual-overlap", "contact-limit", "unresolved-contact"];
export type EncounterEvent = { sequence: number; tick: number } & (
  | { kind: "activate"; id: number }
  | { kind: "fault"; id: number; reason: PoseFault }
  | {
      kind: "resolve";
      id: number;
      reason: "killed" | "retreated" | "crushed" | "out-of-bounds";
      killerId: number | null;
    }
  | { kind: "objective"; id: number }
  | { kind: "retire" }
);
export interface EncounterObservation {
  id: number;
  /** Stable physical/action progress, excluding clocks, retry counters and animation frames. */
  progressKey: string;
  unreachable: boolean;
}
interface MemberState {
  id: number;
  status: "pending" | "alive" | "resolved";
  activatedTick: number | null;
  resolvedTick: number | null;
  reason: Resolution | null;
  killerId: number | null;
  progressKey: string | null;
  unchangedSince: number | null;
  unreachableSince: number | null;
  warnedUnchanged: boolean;
  warnedUnreachable: boolean;
}
export interface EncounterFailure {
  id: number;
  tick: number;
  reason: "critical-loss" | "forbidden-retreat" | "invalid-pose";
  cause: PoseFault | "retreated" | "crushed" | "out-of-bounds";
}
export interface EncounterState {
  definitionKey: string;
  tick: number;
  phase: "active" | "complete" | "retired" | "failed";
  members: MemberState[];
  objectives: Array<{ id: number; completedTick: number | null }>;
  kills: Array<{ playerId: number; count: number }>;
  /** Contiguous canonical receipts; retained for this bounded encounter's lifetime. */
  receipts: string[];
  failure: EncounterFailure | null;
}
export type EncounterNotice =
  | { kind: "complete" | "retired"; tick: number; encounterId: number }
  | { kind: "failed"; encounterId: number; failure: EncounterFailure }
  | {
      kind: "watchdog";
      tick: number;
      encounterId: number;
      id: number;
      sinceTick: number;
      reason: "unchanged" | "unreachable";
      progressKey: string;
    }
  | { kind: "remove-ambient"; tick: number; id: number; reason: "ambient-timeout" };

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Encounter: ${message}`);
}
function id(value: number): number {
  return integer(value, 1, COUNTER_LIMIT - 1, "encounter ID");
}
function tick(value: number): number {
  return integer(value, 0, COUNTER_LIMIT - 2, "encounter tick");
}
function unique(values: number[]): void {
  for (const value of values) id(value);
  check(new Set(values).size === values.length, "duplicate ID");
}
export function encounterCounts(state: EncounterState) {
  return {
    pending: state.members.filter((m) => m.status === "pending").length,
    alive: state.members.filter((m) => m.status === "alive").length,
    resolved: state.members.filter((m) => m.status === "resolved").length,
  };
}

/** One explicit roster per encounter. Pure, bounded and reconstructible from plain state. */
export class EncounterLifecycle {
  readonly #definition: EncounterDefinition;
  readonly #key: string;
  constructor(definition: EncounterDefinition) {
    id(definition.id);
    integer(definition.participants.length, 1, 4, "participant count");
    integer(definition.members.length, 0, 256, "member count");
    integer(definition.objectives.length, 0, 64, "objective count");
    unique(definition.participants);
    unique(definition.members.map((m) => m.id));
    unique(definition.objectives);
    for (const member of definition.members) {
      for (const flag of [member.required, member.critical, member.retreatAllowed])
        check(typeof flag === "boolean", "member flag");
      integer(member.watchdogTicks, 1, 36000, "watchdog duration");
      check(
        !member.critical || (member.required && !member.retreatAllowed),
        "critical actor policy",
      );
      if (member.ambientCleanupTicks !== null) {
        integer(
          member.ambientCleanupTicks,
          member.watchdogTicks,
          36000,
          "ambient cleanup duration",
        );
        check(!member.required && !member.critical, "required actor cannot use ambient cleanup");
      }
    }
    this.#definition = structuredClone(definition);
    this.#definition.members.sort((a, b) => a.id - b.id);
    this.#definition.participants.sort((a, b) => a - b);
    this.#definition.objectives.sort((a, b) => a - b);
    this.#key = canonical(this.#definition);
    Object.freeze(this);
  }
  begin(startTick = 0): EncounterState {
    tick(startTick);
    return {
      definitionKey: this.#key,
      tick: startTick,
      phase: "active",
      members: this.#definition.members.map((m) => ({
        id: m.id,
        status: "pending",
        activatedTick: null,
        resolvedTick: null,
        reason: null,
        killerId: null,
        progressKey: null,
        unchangedSince: null,
        unreachableSince: null,
        warnedUnchanged: false,
        warnedUnreachable: false,
      })),
      objectives: this.#definition.objectives.map((id) => ({ id, completedTick: null })),
      kills: this.#definition.participants.map((playerId) => ({ playerId, count: 0 })),
      receipts: [],
      failure: null,
    };
  }
  remaining(state: EncounterState): number {
    if (state.phase === "retired") return 0;
    return (
      state.members.filter(
        (m, i) => this.#definition.members[i]?.required && m.status !== "resolved",
      ).length + state.objectives.filter((o) => o.completedTick === null).length
    );
  }
  /** Check a saved continuation without advancing clocks, watchdogs or event receipts. */
  restore(state: EncounterState): EncounterState {
    this.#validate(state);
    return structuredClone(state);
  }
  step(
    current: EncounterState,
    atTick: number,
    events: readonly EncounterEvent[],
    observations: readonly EncounterObservation[],
    failureMode: "record" | "throw" = "record",
  ) {
    this.#validate(current);
    tick(atTick);
    check(atTick === current.tick + 1, "nonconsecutive tick");
    check(failureMode === "record" || failureMode === "throw", "failure mode");
    integer(events.length, 0, 1024, "event batch size");
    integer(observations.length, 0, 256, "observation count");
    const state = structuredClone(current);
    state.tick = atTick;
    const notices: EncounterNotice[] = [];
    const fail = (
      memberId: number,
      reason: EncounterFailure["reason"],
      cause: EncounterFailure["cause"],
    ) => {
      if (state.failure) return;
      state.failure = { id: memberId, tick: atTick, reason, cause };
      state.phase = "failed";
      notices.push({
        kind: "failed",
        encounterId: this.#definition.id,
        failure: { ...state.failure },
      });
    };
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
      integer(event.sequence, 1, 1024, "event sequence");
      tick(event.tick);
      const signature = canonical(event);
      if (event.sequence <= state.receipts.length) {
        check(state.receipts[event.sequence - 1] === signature, "conflicting duplicate event");
        continue;
      }
      check(event.sequence === state.receipts.length + 1, "event sequence gap");
      check(event.tick === atTick, "event effective tick mismatch");
      check(
        state.phase !== "retired" && current.phase !== "failed",
        "event after terminal encounter",
      );
      if (event.kind === "retire") {
        check(!state.failure, "cannot retire failed encounter");
        check(Object.keys(event).length === 3, "retire event fields");
        for (const member of state.members)
          if (member.status !== "resolved") {
            member.status = "resolved";
            member.reason = "checkpoint-retired";
            member.resolvedTick = atTick;
          }
        state.phase = "retired";
        notices.push({ kind: "retired", tick: atTick, encounterId: this.#definition.id });
      } else if (event.kind === "objective") {
        check(Object.keys(event).length === 4, "objective event fields");
        const objective = state.objectives.find((o) => o.id === event.id);
        check(objective && objective.completedTick === null, "unknown/completed objective");
        objective.completedTick = atTick;
      } else {
        const index = state.members.findIndex((m) => m.id === event.id),
          member = state.members[index],
          policy = this.#definition.members[index];
        check(member && policy, "unknown member");
        if (event.kind === "activate") {
          check(Object.keys(event).length === 4, "activation fields");
          check(member.status === "pending", "member already activated/resolved");
          member.status = "alive";
          member.activatedTick = atTick;
        } else if (event.kind === "fault") {
          check(
            Object.keys(event).length === 5 && POSE_FAULTS.includes(event.reason),
            "pose fault fields",
          );
          check(member.status === "alive", "fault of nonliving member");
          fail(event.id, policy.critical ? "critical-loss" : "invalid-pose", event.reason);
        } else {
          check(event.kind === "resolve" && Object.keys(event).length === 6, "resolution fields");
          check(member.status === "alive", "resolution of nonliving member");
          check(
            ["killed", "retreated", "crushed", "out-of-bounds"].includes(event.reason),
            "resolution reason",
          );
          check(
            event.killerId === null ||
              (event.reason === "killed" && this.#definition.participants.includes(event.killerId)),
            "invalid kill attribution",
          );
          member.status = "resolved";
          member.resolvedTick = atTick;
          member.reason = event.reason;
          member.killerId = event.killerId;
          if (event.killerId !== null) {
            const credit = state.kills.find((k) => k.playerId === event.killerId);
            check(credit, "unknown participant");
            credit.count++;
          }
          if (policy.critical && event.reason !== "killed")
            fail(event.id, "critical-loss", event.reason);
          else if (event.reason === "retreated" && !policy.retreatAllowed)
            fail(event.id, "forbidden-retreat", event.reason);
        }
      }
      state.receipts.push(signature);
    }
    const observed = new Map<number, EncounterObservation>();
    for (const observation of observations) {
      id(observation.id);
      check(!observed.has(observation.id), "duplicate observation");
      check(
        typeof observation.progressKey === "string" &&
          observation.progressKey.length > 0 &&
          observation.progressKey.length <= 256 &&
          typeof observation.unreachable === "boolean",
        "invalid progress observation",
      );
      check(
        state.members.some((m) => m.id === observation.id),
        "unknown observed member",
      );
      observed.set(observation.id, observation);
    }
    if (state.phase !== "failed" && state.phase !== "retired") {
      for (let i = 0; i < state.members.length; i++) {
        const member = state.members[i],
          policy = this.#definition.members[i];
        check(member && policy, "missing member policy");
        if (member.status !== "alive") continue;
        const observation = observed.get(member.id);
        check(observation, "missing living member observation");
        if (member.progressKey !== observation.progressKey) {
          member.progressKey = observation.progressKey;
          member.unchangedSince = atTick;
          member.warnedUnchanged = false;
        }
        if (!observation.unreachable) {
          member.unreachableSince = null;
          member.warnedUnreachable = false;
        } else if (member.unreachableSince === null) member.unreachableSince = atTick;
        for (const reason of ["unchanged", "unreachable"] as const) {
          const since = reason === "unchanged" ? member.unchangedSince : member.unreachableSince;
          const warned = reason === "unchanged" ? member.warnedUnchanged : member.warnedUnreachable;
          if (since !== null && atTick - since >= policy.watchdogTicks && !warned) {
            notices.push({
              kind: "watchdog",
              tick: atTick,
              encounterId: this.#definition.id,
              id: member.id,
              sinceTick: since,
              reason,
              progressKey: observation.progressKey,
            });
            if (reason === "unchanged") member.warnedUnchanged = true;
            else member.warnedUnreachable = true;
          }
        }
        const stalledSince = member.unreachableSince ?? member.unchangedSince;
        if (
          policy.ambientCleanupTicks !== null &&
          stalledSince !== null &&
          atTick - stalledSince >= policy.ambientCleanupTicks
        ) {
          member.status = "resolved";
          member.resolvedTick = atTick;
          member.reason = "ambient-timeout";
          notices.push({
            kind: "remove-ambient",
            tick: atTick,
            id: member.id,
            reason: "ambient-timeout",
          });
        }
      }
      if (state.phase === "active" && this.remaining(state) === 0) {
        state.phase = "complete";
        notices.push({ kind: "complete", tick: atTick, encounterId: this.#definition.id });
      }
    }
    if (failureMode === "throw" && state.failure)
      throw new Error(
        `Encounter ${this.#definition.id} ${state.failure.reason}: ${state.failure.id} at ${state.failure.tick}`,
      );
    return { state, notices, remaining: this.remaining(state), counts: encounterCounts(state) };
  }
  #validate(state: EncounterState): void {
    check(state.definitionKey === this.#key, "definition mismatch");
    tick(state.tick);
    check(["active", "complete", "retired", "failed"].includes(state.phase), "phase");
    check(
      state.members.length === this.#definition.members.length &&
        state.members.every((m, i) => m.id === this.#definition.members[i]?.id),
      "roster mismatch",
    );
    check(
      state.objectives.length === this.#definition.objectives.length &&
        state.objectives.every((o, i) => o.id === this.#definition.objectives[i]),
      "objective roster mismatch",
    );
    check(
      state.kills.length === this.#definition.participants.length &&
        state.kills.every((k, i) => k.playerId === this.#definition.participants[i]),
      "participant mismatch",
    );
    integer(state.receipts.length, 0, 1024, "receipt count");
    for (let i = 0; i < state.receipts.length; i++) {
      const receipt = state.receipts[i];
      check(typeof receipt === "string" && receipt.length <= 512, "receipt length");
      const event = JSON.parse(receipt) as EncounterEvent;
      tick(event.tick);
      check(
        event.sequence === i + 1 && event.tick <= state.tick && canonical(event) === receipt,
        "receipt continuation",
      );
    }
    for (const member of state.members) {
      check(["pending", "alive", "resolved"].includes(member.status), "member status");
      for (const value of [
        member.activatedTick,
        member.resolvedTick,
        member.unchangedSince,
        member.unreachableSince,
      ])
        if (value !== null) {
          tick(value);
          check(value <= state.tick, "future member tick");
        }
      check(
        (member.status === "resolved") === (member.reason !== null) &&
          (member.status === "resolved") === (member.resolvedTick !== null),
        "resolution state",
      );
      check(
        member.reason === null ||
          [
            "killed",
            "retreated",
            "crushed",
            "out-of-bounds",
            "ambient-timeout",
            "checkpoint-retired",
          ].includes(member.reason),
        "unknown saved resolution",
      );
      check(
        member.killerId === null ||
          (member.reason === "killed" && this.#definition.participants.includes(member.killerId)),
        "saved kill attribution",
      );
      check(member.status !== "alive" || member.activatedTick !== null, "missing activation");
      check(
        member.status !== "pending" ||
          (member.activatedTick === null &&
            member.progressKey === null &&
            member.unchangedSince === null &&
            member.unreachableSince === null),
        "pending member continuation",
      );
      check(
        member.progressKey === null ||
          (typeof member.progressKey === "string" &&
            member.progressKey.length > 0 &&
            member.progressKey.length <= 256),
        "saved progress key",
      );
      check(
        typeof member.warnedUnchanged === "boolean" &&
          typeof member.warnedUnreachable === "boolean",
        "saved watchdog flags",
      );
      check(
        (member.progressKey === null) === (member.unchangedSince === null),
        "saved progress timer",
      );
    }
    for (const objective of state.objectives)
      if (objective.completedTick !== null) {
        tick(objective.completedTick);
        check(objective.completedTick <= state.tick, "future objective tick");
      }
    for (const credit of state.kills) {
      integer(credit.count, 0, 256, "kill count");
      check(
        credit.count ===
          state.members.filter((m) => m.reason === "killed" && m.killerId === credit.playerId)
            .length,
        "kill count mismatch",
      );
    }
    check((state.phase === "failed") === (state.failure !== null), "failure state");
    if (state.failure) {
      tick(state.failure.tick);
      check(
        state.failure.tick <= state.tick &&
          state.members.some((m) => m.id === state.failure?.id) &&
          ["critical-loss", "forbidden-retreat", "invalid-pose"].includes(state.failure.reason) &&
          [...POSE_FAULTS, "retreated", "crushed", "out-of-bounds"].includes(state.failure.cause),
        "invalid failure continuation",
      );
    }
    check(state.phase !== "complete" || this.remaining(state) === 0, "premature completion");
  }
}
