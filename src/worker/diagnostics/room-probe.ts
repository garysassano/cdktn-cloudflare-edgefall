import { DurableObject } from "cloudflare:workers";
import { COUNTER_LIMIT } from "../../game/core/numeric.js";
import type { CombatLab } from "../../game/labs/combat.js";
import type { CombatCampaign } from "../../game/labs/combat-campaign.js";
import type { GameIdentity } from "../../shared/content-id.js";
import { combatEventContext } from "../../shared/diagnostics/combat-events.js";
import {
  type CombatConnectionChange,
  type CombatJournalTick,
  type CombatRuntime,
  combatRuntimeHash,
  createCombatRuntime,
  stageCombatRuntime,
} from "../../shared/diagnostics/combat-runtime.js";
import { combatIdentity, combatPeerContext } from "../../shared/diagnostics/combat-workload.js";
import { CombatJournalWriter } from "../../shared/diagnostics/combat-writer.js";
import {
  controllerPeerContext,
  recoverControllerWorld,
} from "../../shared/diagnostics/controller-recovery.js";
import {
  CONTROLLER_IDENTITY,
  CONTROLLER_INPUT_PREFILL_TICKS,
  createControllerWorkload,
  stepNetworkController,
} from "../../shared/diagnostics/controller-workload.js";
import type { PeerMetrics, RoomProbeStatus } from "../../shared/diagnostics/room-probe-types.js";
import {
  PROBE_IDENTITY,
  createRoomWorkload,
  probeContext,
  roomWorkloadHash,
  stepRoomWorkload,
} from "../../shared/diagnostics/room-workload.js";
import { decodeInputBatch } from "../../shared/protocol/codec.js";
import {
  type EventHistory,
  acceptsEventBaseline,
  eventBatches,
} from "../../shared/protocol/event-stream.js";
import {
  EVENT_CAPABILITY,
  type EventBaseline,
  decodeEventResyncRequest,
  encodeEventBatch,
} from "../../shared/protocol/events.js";
import type { Handshake } from "../../shared/protocol/handshake.js";
import {
  INPUT_MAPPING_CAPABILITY,
  mappingForSnapshot,
} from "../../shared/protocol/input-mapping.js";
import type { WorldInputOutcome } from "../../shared/protocol/input-stream.js";
import { InputStream } from "../../shared/protocol/input-stream.js";
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from "../../shared/protocol/limits.js";
import { encodeSnapshot } from "../../shared/protocol/snapshot.js";
import { RoomClock } from "../../shared/runtime/room-clock.js";
import {
  admitMember,
  checkpointMembership,
  disconnectMember,
  emptyReservationDeadline,
} from "../../shared/session/membership.js";
import {
  PROFILE_COOKIE_NAME,
  profileCookie,
  signProfileIdentity,
  verifyProfileIdentity,
} from "../../shared/session/profile.js";
import {
  type HostCommand,
  readHostCommand,
  requireCurrentHost,
  roomControlState,
} from "../../shared/session/room-control.js";
import {
  type PausableRoomMode,
  type RoomMode,
  isPausableRoom,
  isWaitingRoom,
} from "../../shared/session/room-phase.js";
import { ControlLease } from "../runtime/control-lease.js";
import { CombatStorage } from "./combat-storage.js";
import { MembershipStorage } from "./membership-storage.js";

interface ProbeEnv {
  ROOM_PROBES: DurableObjectNamespace<RoomLoadProbe>;
  PROFILE_COOKIE_SECRET: string;
  PROBE_COMBAT_SCENARIO?: string;
}
interface Peer {
  generation: number;
  initialBaseline: { snapshotId: number; cursor: number } | null;
  baselineTick: number;
  lastRoomMode: RoomMode;
  inputPauseSnapshotId: number | null;
  socket: WebSocket;
  input: InputStream;
  lease: ControlLease | null;
  lastAckAt: number;
  pendingEventBaseline: EventBaseline | null;
  eventBeforeBaseline: number;
  metrics: PeerMetrics;
}

/** Separate loopback diagnostics only: synthetic load and the real controller workload. */
export class RoomLoadProbe extends DurableObject<ProbeEnv> {
  private readonly instanceId = crypto.randomUUID();
  private workload: "standard" | "double" | "controller" | "combat" = "standard";
  private world = createRoomWorkload(1);
  private combat: CombatLab | null = null;
  private campaign: CombatCampaign | null = null;
  private eventHistory: EventHistory | null = null;
  private connectedPlayerIds: number[] = [];
  private pausedFrom: PausableRoomMode | null = null;
  private combatStore: CombatStorage | null = null;
  private combatWriter: CombatJournalWriter | null = null;
  private recoveryBoundary: RoomProbeStatus["recoveryBoundary"] = null;
  private persistenceFailure: string | null = null;
  private failNextPersistence = false;
  private holdNextPersistence = false;
  private heldPersistence: { release: () => void; reject: () => void } | null = null;
  private starting = false;
  private pausing: Promise<void> | null = null;
  private alarmAtMs: number | null = null;
  private alarmDeliveries = 0;
  private emptyPause: RoomProbeStatus["emptyPause"] = null;
  private identity: Promise<GameIdentity> = Promise.resolve(PROBE_IDENTITY);
  private failNextCombatTick = false;
  private worldFailure: string | null = null;
  private readonly peers = new Map<number, Peer>();
  private readonly pendingPeers = new Map<number, Peer>();
  private readonly admissions = new Map<number, Promise<void>>();
  private members: MembershipStorage | null = null;
  private resolvedIdentity: GameIdentity = PROBE_IDENTITY;
  private staleSocketEvents = 0;
  private readonly connections: RoomProbeStatus["connections"] = [];
  private readonly localCpu: RoomProbeStatus["localCpu"] = [];
  private readonly callbacks: RoomProbeStatus["callbacks"] = [];
  private readonly timers: RoomProbeStatus["timers"] = [];
  private readonly inputTimeline: RoomProbeStatus["inputTimeline"] = [];
  private get controllerInputs() {
    return this.workload === "controller" || this.workload === "combat";
  }
  private traceInput(
    peer: Peer,
    kind: "admit" | "apply" | "reject",
    runtimeMs: number,
    serverTick: number,
    firstSequence: number,
    lastSequence: number,
    outcome: string,
  ) {
    if (!this.controllerInputs || this.inputTimeline.length >= 6400) return;
    this.inputTimeline.push({
      runEpoch: this.world.runEpoch,
      slot: peer.metrics.slot,
      kind,
      runtimeMs,
      serverTick,
      baselineTick: peer.baselineTick,
      firstSequence,
      lastSequence,
      queued: peer.input.queuedCommands,
      outcome,
    });
  }
  private sampledNow = 0;
  private startedAtTick = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private initialization: Promise<void> | null = null;
  private recoveries = 0;
  private clock = this.createClock(0);
  private createClock(initialTick: number): RoomClock {
    return new RoomClock({
      initialTick,
      port: {
        now: () => {
          this.sampledNow = performance.now();
          return this.sampledNow;
        },
        schedule: (callback, delay) => {
          const row: [number, number, number | null] = [performance.now(), delay, null];
          if (this.timers.length < 2401) this.timers.push(row);
          const timer = setTimeout(() => {
            row[2] = performance.now();
            callback();
          }, delay);
          return () => clearTimeout(timer);
        },
      },
      step: (tick) => {
        try {
          return this.step(tick);
        } catch (error) {
          this.worldFailure = String(error).slice(0, 256);
          throw error;
        }
      },
      onSample: (sample) => {
        if (this.callbacks.length >= 2400) {
          this.finish("callback-limit");
          return;
        }
        this.callbacks.push([
          sample.observedAtMs,
          sample.steps,
          sample.lastCompletedTick,
          sample.latenessMs,
        ]);
      },
      onDiscontinuity: () => {
        this.world.roomMode = "recovering";
        this.clearWatchdog();
        this.disconnectAll("clock-fault");
      },
    });
  }

  constructor(ctx: DurableObjectState, env: ProbeEnv) {
    super(ctx, env);
    // Old input generations close; combat initialization restores SQLite before a new welcome.
    for (const socket of ctx.getWebSockets()) socket.close(1012, "probe-restarted");
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
  private disconnect(
    peer: Peer,
    reason: string,
    code = 4001,
    decisionTick = this.world.tick,
  ): void {
    if (!peer.metrics.active) return;
    peer.metrics.active = false;
    peer.metrics.closeReason = reason;
    peer.metrics.lastHeld = 0;
    if (this.members)
      this.members.save(
        disconnectMember(this.members.state, peer.metrics.slot, peer.generation, Date.now()),
      );
    if (reason === "lease-expired") peer.metrics.expiredAtTick = decisionTick;
    try {
      peer.socket.close(code, reason);
    } catch (error) {
      peer.metrics.lastOutputError ??= String(error).slice(0, 256);
    }
    this.pauseEmpty();
    if (this.workload === "combat" && this.world.roomMode === "completed" && !this.hasPeers())
      this.ctx.waitUntil(this.scheduleExpiry());
  }
  private disconnectAll(reason: string): void {
    for (const peer of this.peers.values()) this.disconnect(peer, reason, 4003);
    for (const peer of this.pendingPeers.values()) this.disconnect(peer, reason, 4003);
    this.pendingPeers.clear();
    if (this.workload === "combat" && this.world.roomMode !== "expired")
      this.ctx.waitUntil(this.scheduleExpiry());
  }
  private hasPeers(): boolean {
    return [...this.peers.values(), ...this.pendingPeers.values()].some(
      (peer) => peer.metrics.active,
    );
  }
  private async scheduleExpiry() {
    const deadline = this.members && emptyReservationDeadline(this.members.state);
    if (deadline !== null && deadline !== undefined) {
      this.alarmAtMs = deadline;
      await this.ctx.storage.setAlarm(deadline);
    }
  }
  private async clearExpiry() {
    this.alarmAtMs = null;
    await this.ctx.storage.deleteAlarm();
  }
  private pauseEmpty(): void {
    if (
      this.workload !== "combat" ||
      this.pausing ||
      this.starting ||
      !isPausableRoom(this.world.roomMode) ||
      this.hasPeers()
    )
      return;
    const accepted = structuredClone(this.combatRuntime());
    this.emptyPause = null;
    this.clock.stop();
    this.clearWatchdog();
    this.world.roomMode = "paused-empty";
    this.world.stateHash = roomWorkloadHash(this.world);
    this.starting = true;
    this.pausing = (async () => {
      // In-flight admissions observe the changed phase, undo their claim and settle first.
      await Promise.all(this.admissions.values());
      await this.scheduleExpiry();
      if (!this.combatStore) throw new Error("Missing combat store");
      const durable = this.combatWriter ? await this.combatWriter.seal(accepted) : accepted;
      if (this.world.roomMode !== "paused-empty") return;
      const paused = await this.combatStore.transition(durable, "pause");
      if (this.world.roomMode !== "paused-empty") return;
      this.installCombat(paused);
      this.emptyPause = {
        tick: paused.combat.tick,
        runEpoch: paused.snapshot.runEpoch,
        hash: combatRuntimeHash(paused),
      };
    })()
      .catch((error) => this.pausePersistence(String(error)))
      .finally(() => {
        this.pausing = null;
        this.starting = false;
      });
    this.ctx.waitUntil(this.pausing);
  }
  /** Advertise the nonterminal input pause immediately; host reset stays locked until storage confirms. */
  private confirmCampaignBoundary(): void {
    if (this.starting || this.pausing || this.world.roomMode !== "intermission") return;
    const accepted = structuredClone(this.combatRuntime());
    this.clock.stop();
    this.clearWatchdog();
    this.starting = true;
    for (const peer of this.peers.values()) {
      peer.lease = null;
      if (peer.metrics.active) this.publishSnapshot(peer);
    }
    this.pausing = (async () => {
      if (!this.combatWriter) throw new Error("Missing campaign boundary writer");
      const durable = await this.combatWriter.seal(accepted);
      if (this.world.roomMode !== "intermission") return;
      if (combatRuntimeHash(durable) !== combatRuntimeHash(this.combatRuntime()))
        throw new Error("Campaign boundary changed during confirmation");
      this.combatWriter = null;
    })()
      .catch((error) => this.pausePersistence(String(error)))
      .finally(() => {
        this.pausing = null;
        this.starting = false;
        this.pauseEmpty();
      });
    this.ctx.waitUntil(this.pausing);
  }
  private admissionPhase(): RoomMode {
    return this.campaign && ["wipe", "defeat"].includes(this.campaign.state.phase)
      ? "playing"
      : this.world.roomMode;
  }
  async alarm(): Promise<void> {
    this.alarmDeliveries++;
    this.initialization ??= this.ctx.blockConcurrencyWhile(() => this.initialize("combat"));
    await this.initialization;
    await this.pausing;
    if (this.world.roomMode === "expired" || this.hasPeers()) {
      await this.clearExpiry();
      return;
    }
    if (this.starting || this.admissions.size) {
      this.alarmAtMs = Date.now() + 1000;
      await this.ctx.storage.setAlarm(this.alarmAtMs);
      return;
    }
    const deadline = this.members && emptyReservationDeadline(this.members.state);
    if (deadline === null || deadline === undefined) return;
    if (Date.now() < deadline) {
      await this.scheduleExpiry();
      return;
    }
    this.starting = true;
    this.clock.close();
    this.clearWatchdog();
    try {
      await this.combatWriter?.retire();
      this.combatWriter = null;
      const previous = await this.combatStore?.load();
      if (!previous || !this.combatStore) throw new Error("Missing expiry checkpoint");
      const expired =
        previous.snapshot.roomMode === "expired"
          ? previous
          : await this.combatStore.transition(previous, "expire");
      this.installCombat(expired);
      this.peers.clear();
      this.pendingPeers.clear();
      await this.clearExpiry();
    } finally {
      this.starting = false;
    }
  }
  private finish(reason: string): void {
    this.clock.close();
    this.clearWatchdog();
    this.world.roomMode = "expired";
    this.pausedFrom = null;
    this.disconnectAll(reason);
    this.heldPersistence?.reject();
  }

  private context(slot: number) {
    return this.combat
      ? combatPeerContext(this.world, slot)
      : this.controllerInputs
        ? controllerPeerContext(this.world, slot)
        : probeContext(slot);
  }
  private newInput(slot: number, baselineServerTick: number) {
    return new InputStream({
      ...this.context(slot),
      controlEpoch: this.world.players[slot]?.controlEpoch ?? 1,
      baselineServerTick,
    });
  }
  private welcome(peer: Peer): void {
    const slot = peer.metrics.slot;
    const welcome: Handshake = {
      ...this.resolvedIdentity,
      type: "welcome",
      protocolMajor: PROTOCOL_MAJOR,
      protocolMinor: PROTOCOL_MINOR,
      runId: "local-room-workload",
      runEpoch: this.world.runEpoch,
      connectionEpoch: this.context(slot).connectionEpoch,
      playerId: slot + 1,
      entityId: slot + 1,
      simulationHz: 60,
      snapshotHz: 20,
      initialServerTick: this.world.tick,
      capabilities:
        this.workload === "combat"
          ? ((INPUT_MAPPING_CAPABILITY | EVENT_CAPABILITY) as 3)
          : this.controllerInputs
            ? INPUT_MAPPING_CAPABILITY
            : 0,
      baselineSnapshotId: this.world.snapshotId + 1,
      baselineEventCursor: this.world.baselineEventCursor,
      buildId: "4".repeat(64),
    };
    try {
      peer.socket.send(JSON.stringify(welcome));
      this.world.stateHash = roomWorkloadHash(this.world);
      this.snapshot(peer, undefined, true);
    } catch (error) {
      peer.metrics.lastOutputError = String(error).slice(0, 256);
      this.disconnect(peer, "welcome-failed", 4002);
    }
  }

  private snapshot(peer: Peer, requestedRepair?: EventBaseline["reason"], initial = false): void {
    if (peer.pendingEventBaseline || peer.initialBaseline) return;
    this.world.snapshotId++;
    const context = this.context(peer.metrics.slot);
    this.world.connectionEpoch = context.connectionEpoch;
    const bytes = encodeSnapshot(this.world, context);
    const batches =
      this.eventHistory && !initial
        ? eventBatches(
            this.eventHistory,
            peer.input.deliveryAcknowledgments.event,
            context.connectionEpoch,
          )
        : [];
    let baseline: EventBaseline | null = null;
    if (requestedRepair || batches === null) {
      if (++peer.metrics.eventBaselines > 8) throw new Error("Event baseline repair limit");
      baseline = {
        type: "resync-required",
        scope: "events",
        reason: requestedRepair ?? "history-expired",
        runEpoch: context.runEpoch,
        connectionEpoch: context.connectionEpoch,
        snapshotId: this.world.snapshotId,
        tick: this.world.tick,
        baselineEventCursor: this.world.baselineEventCursor,
      };
      peer.eventBeforeBaseline = peer.metrics.eventSentCursor;
      peer.socket.send(JSON.stringify(baseline));
    } else
      for (const batch of batches) {
        const events = encodeEventBatch(batch, combatEventContext(context));
        peer.socket.send(events);
        peer.metrics.eventBytes += events.byteLength;
        peer.metrics.eventFrames++;
      }
    if (this.controllerInputs) {
      const mapping = JSON.stringify(mappingForSnapshot(this.world, context.playerId));
      peer.socket.send(mapping);
      peer.metrics.inputMappingBytes += new TextEncoder().encode(mapping).byteLength;
    }
    peer.socket.send(bytes);
    const cursor = this.eventHistory?.cursor ?? 0;
    peer.input.recordSent(this.world.snapshotId, cursor);
    if (
      this.world.roomMode === "intermission" &&
      this.campaign &&
      ["wipe", "defeat"].includes(this.campaign.state.phase)
    )
      peer.inputPauseSnapshotId ??= this.world.snapshotId;
    peer.metrics.eventSentCursor = cursor;
    peer.pendingEventBaseline = baseline;
    if (initial && this.workload === "combat")
      peer.initialBaseline = { snapshotId: this.world.snapshotId, cursor };
    peer.metrics.snapshots++;
    peer.metrics.snapshotBytes += bytes.byteLength;
    peer.lastRoomMode = this.world.roomMode;
  }

  private publishSnapshot(peer: Peer, repair?: EventBaseline["reason"]): void {
    try {
      this.snapshot(peer, repair);
    } catch (error) {
      // Delivery failure cannot turn an already committed world tick into a failed clock step.
      peer.metrics.lastOutputError = String(error).slice(0, 256);
      this.disconnect(peer, "snapshot-failed", 4002);
    }
  }

  private step(tick: number): undefined | "paused" {
    const cpuStart = performance.now(); // Local CPU diagnostic only; never enters world arithmetic.
    const replacements = [...this.pendingPeers].sort(([a], [b]) => a - b);
    const cohort = new Map([...this.peers, ...replacements]);
    const active = [...cohort]
      .sort(([a], [b]) => a - b)
      .filter(([, peer]) => {
        if (!peer.metrics.active) return false;
        if (peer.lease?.expired(this.sampledNow))
          this.disconnect(peer, "lease-expired", 4001, tick);
        else if (this.sampledNow - peer.lastAckAt >= 1000)
          this.disconnect(peer, "reader-stalled", 4002);
        return peer.metrics.active;
      });
    if (this.workload === "combat" && active.length === 0) {
      this.pauseEmpty();
      return "paused";
    }
    const transaction = InputStream.processWorldTick<{
      snapshot: CombatRuntime["snapshot"];
      combat: CombatLab | null;
      history: EventHistory | null;
      connectedPlayerIds: number[];
      pausedFrom: PausableRoomMode | null;
      campaign: CombatCampaign | null;
      journal: CombatJournalTick | null;
    }>(
      active.map(([, peer]) => peer.input),
      tick,
      this.sampledNow,
      (prepared) => {
        if (this.workload === "combat") {
          if (!this.combat || !this.eventHistory) throw new Error("Missing combat world/history");
          const changes: CombatConnectionChange[] = replacements.map(([slot, peer]) => ({
            playerId: slot + 1,
            connectionEpoch: peer.input.acknowledgment.connectionEpoch,
          }));
          const result = stageCombatRuntime(this.combatRuntime(), prepared, changes);
          const history = result.state.history;
          for (const [slot] of active) {
            const context = combatPeerContext(result.state.snapshot, slot);
            encodeSnapshot(
              { ...result.state.snapshot, connectionEpoch: context.connectionEpoch },
              context,
            );
            for (const batch of eventBatches(
              history,
              this.eventHistory.cursor,
              context.connectionEpoch,
            ) ?? [])
              encodeEventBatch(batch, combatEventContext(context));
          }
          if (this.failNextCombatTick) {
            this.failNextCombatTick = false;
            throw new Error("injected-combat-commit-failure");
          }
          return { ...result, state: { ...result.state, journal: result.journal } };
        }
        const candidate = structuredClone(this.world);
        const outcomes: WorldInputOutcome[] = prepared.map(({ input }) => ({
          playerId: input.playerId,
          edgeResults: input.command.edges.map((edge) => ({
            ...edge,
            outcome: "unavailable" as const,
          })),
        }));
        if (this.workload === "controller") {
          for (const [slot, actor] of candidate.players.entries()) {
            const item = prepared.find(({ input }) => input.playerId === actor.playerId);
            const command = item?.input.command ?? {
              sequence: 0,
              clientTick: 0,
              controlEpoch: actor.controlEpoch,
              held: 0,
              aim: 0 as const,
              edges: [],
            };
            const result = stepNetworkController(
              actor,
              { ...command, controlEpoch: actor.controlEpoch },
              tick,
            );
            candidate.players[slot] = result.actor;
            const outcome = outcomes.find((value) => value.playerId === actor.playerId);
            if (outcome) outcome.edgeResults = result.edges;
          }
          candidate.tick = tick;
        } else {
          for (const actor of candidate.players) actor.body.vx = 0;
          stepRoomWorkload(
            candidate,
            tick,
            prepared.map(({ input }) => input),
          );
        }
        for (const item of prepared) {
          const slot = candidate.players.findIndex(
            (actor) => actor.playerId === item.input.playerId,
          );
          const actor = candidate.players[slot];
          if (!actor) throw new Error("Missing committed input owner");
          candidate.acknowledgments[slot] = item.acknowledgment;
          actor.processedEdgeIds = [...item.acknowledgment.processedEdgeIds];
        }
        // Validate the candidate before the transaction can consume any input or advance any ack.
        for (const [slot] of active) {
          const context = this.context(slot);
          encodeSnapshot({ ...candidate, connectionEpoch: context.connectionEpoch }, context);
        }
        return {
          state: {
            snapshot: candidate,
            combat: this.combat,
            history: this.eventHistory,
            connectedPlayerIds: this.connectedPlayerIds,
            pausedFrom: this.pausedFrom,
            campaign: this.campaign,
            journal: null,
          },
          outcomes,
        };
      },
    );
    this.world = transaction.state.snapshot;
    this.combat = transaction.state.combat;
    this.eventHistory = transaction.state.history;
    this.connectedPlayerIds = transaction.state.connectedPlayerIds;
    this.pausedFrom = transaction.state.pausedFrom;
    this.campaign = transaction.state.campaign;
    for (const [slot, peer] of replacements) {
      const old = this.peers.get(slot);
      if (old) this.disconnect(old, "connection-replaced", 4003);
      this.peers.set(slot, peer);
      this.pendingPeers.delete(slot);
      peer.baselineTick = tick;
      peer.input = this.newInput(slot, tick);
      peer.lastAckAt = this.sampledNow;
      peer.lease = new ControlLease(this.sampledNow);
      this.connections.push({
        tick,
        slot,
        connectionEpoch: this.context(slot).connectionEpoch,
        controlEpoch: this.world.players[slot]?.controlEpoch ?? 0,
        baselineEventCursor: this.world.baselineEventCursor,
      });
    }
    if (transaction.state.journal) {
      try {
        if (!this.combatWriter) throw new Error("Missing combat journal writer");
        this.combatWriter.record(transaction.state.journal, this.combatRuntime());
      } catch (error) {
        // This tick has committed. Pause output/input without turning it into a clock step failure.
        this.pausePersistence(String(error));
      }
    }
    for (const [, peer] of replacements) if (peer.metrics.active) this.welcome(peer);
    for (const processed of transaction.processed) {
      const slot = this.world.players.find(
        (actor) => actor.playerId === processed.input.playerId,
      )?.slot;
      const peer = slot === undefined ? undefined : this.peers.get(slot);
      if (!peer) throw new Error("Missing committed peer");
      const submitted = processed.input.submittedCommand?.sequence ?? 0;
      this.traceInput(
        peer,
        "apply",
        this.sampledNow,
        tick,
        submitted,
        submitted,
        processed.input.repeatedHeld
          ? `repeat:${processed.input.outcome}`
          : processed.input.outcome,
      );
      peer.metrics.lastHeld = processed.input.command.held;
      peer.metrics.lastProcessedSequence = processed.acknowledgment.lastProcessedSequence;
      if (processed.neutralized && peer.metrics.neutralizedAtTick === null)
        peer.metrics.neutralizedAtTick = tick;
    }
    if (
      this.world.roomMode === "playing" &&
      ![...this.peers.values()].some((peer) => peer.metrics.active)
    ) {
      if (this.workload === "combat") this.pauseEmpty();
      else {
        this.world.roomMode = "paused-empty";
        this.clock.stop();
        this.clearWatchdog();
      }
    }
    if (this.workload === "combat" && this.world.roomMode === "intermission")
      this.confirmCampaignBoundary();
    let encodeMs = 0;
    if (tick % 3 === 0 && this.world.roomMode === "playing") {
      this.world.stateHash = roomWorkloadHash(this.world);
      const encodeStart = performance.now();
      for (const peer of this.peers.values()) {
        // Do not enqueue replaceable snapshots forever for a client whose acks stopped.
        if (peer.metrics.active && this.sampledNow - peer.lastAckAt < 500)
          this.publishSnapshot(peer);
      }
      encodeMs = performance.now() - encodeStart;
    }
    if (this.localCpu.length < 1200)
      this.localCpu.push([tick, performance.now() - cpuStart, encodeMs]);
    if (tick - this.startedAtTick >= 1200) this.finish("tick-limit");
    return undefined;
  }

  private combatRuntime(): CombatRuntime {
    if (!this.combat || !this.eventHistory || !this.campaign)
      throw new Error("Missing combat continuation");
    return {
      combat: this.combat,
      snapshot: this.world,
      history: this.eventHistory,
      connectedPlayerIds: this.connectedPlayerIds,
      pausedFrom: this.pausedFrom,
      campaign: this.campaign,
    };
  }
  private installCombat(state: CombatRuntime) {
    this.world = state.snapshot;
    this.combat = state.combat;
    this.eventHistory = state.history;
    this.connectedPlayerIds = state.connectedPlayerIds;
    this.pausedFrom = state.pausedFrom;
    this.campaign = state.campaign;
  }
  private pausePersistence(reason: string) {
    this.persistenceFailure ??= reason.slice(0, 256);
    this.clock.stop();
    this.clearWatchdog();
    if (this.world.roomMode !== "expired") this.world.roomMode = "recovering";
    this.pausedFrom = null;
    this.disconnectAll("persistence-recovery");
  }
  private async persistCombat(
    start: CombatRuntime,
    entries: readonly CombatJournalTick[],
    accepted: CombatRuntime,
  ) {
    if (!this.combatStore) throw new Error("Missing combat store");
    if (this.holdNextPersistence) {
      this.holdNextPersistence = false;
      // Loopback-only slow I/O injection. It cannot hold a process open indefinitely.
      await new Promise<void>((resolve, reject) => {
        const rejectHeld = () => {
          clearTimeout(timeout);
          this.heldPersistence = null;
          reject(new Error("injected-combat-write-hold-expired"));
        };
        const timeout = setTimeout(rejectHeld, 2000);
        this.heldPersistence = {
          release: () => {
            clearTimeout(timeout);
            this.heldPersistence = null;
            resolve();
          },
          reject: rejectHeld,
        };
      });
    }
    return this.combatStore.commit(start, entries, accepted);
  }
  private async restoreCombat(loaded: CombatRuntime | null = null) {
    if (!this.combatStore) throw new Error("Missing combat store");
    await this.combatWriter?.retire();
    this.combatWriter = null;
    const previous = loaded ?? (await this.combatStore.load());
    if (!previous) throw new Error("Missing durable combat world");
    const state = await this.combatStore.transition(previous, "recover");
    this.recoveryBoundary = {
      fromRunEpoch: previous.snapshot.runEpoch,
      restoredTick: previous.combat.tick,
      restoredHash: combatRuntimeHash(previous),
      runEpoch: state.snapshot.runEpoch,
    };
    this.installCombat(state);
    this.emptyPause = null;
    this.clock = this.createClock(state.combat.tick);
    this.recoveries = state.snapshot.runEpoch - 1;
    this.persistenceFailure = null;
    this.worldFailure = null;
  }
  private async initialize(workload: string | undefined) {
    this.workload =
      workload === "combat"
        ? "combat"
        : workload === "controller"
          ? "controller"
          : workload === "double"
            ? "double"
            : "standard";
    this.world =
      this.workload === "controller"
        ? createControllerWorkload()
        : createRoomWorkload(this.workload === "double" ? 2 : 1);
    if (this.workload === "combat") {
      this.members = new MembershipStorage(this.ctx.storage);
      const requested = this.env.PROBE_COMBAT_SCENARIO ?? "range";
      if (
        requested !== "range" &&
        requested !== "rifle" &&
        requested !== "guard" &&
        requested !== "shotgun" &&
        requested !== "flame" &&
        requested !== "tank" &&
        requested !== "ordnance"
      )
        throw new Error("Unsupported room combat scenario");
      const initial = createCombatRuntime(requested);
      initial.snapshot.roomMode = "lobby";
      initial.snapshot.stateHash = roomWorkloadHash(initial.snapshot);
      initial.connectedPlayerIds = [];
      this.installCombat(initial);
      this.identity = combatIdentity();
      const { simulationVersion, simulationBuild, contentFormat, contentHash } =
        await this.identity;
      this.combatStore = new CombatStorage(
        this.ctx.storage,
        {
          simulationVersion,
          simulationBuild,
          contentFormat,
          contentHash,
          runId: "local-room-workload",
        },
        () => {
          if (this.failNextPersistence) {
            this.failNextPersistence = false;
            throw new Error("injected-combat-storage-failure");
          }
          if (this.members) this.members.save(checkpointMembership(this.members.state, Date.now()));
        },
      );
      const loaded = await this.combatStore.load();
      if (loaded && loaded.combat.scenario !== requested)
        throw new Error("Stored combat scenario differs from deployment");
      if (loaded && ["paused-empty", "completed", "expired"].includes(loaded.snapshot.roomMode)) {
        this.installCombat(loaded);
        this.clock = this.createClock(loaded.combat.tick);
        this.recoveries = loaded.snapshot.runEpoch - 1;
        if (["completed", "expired"].includes(loaded.snapshot.roomMode)) this.clock.close();
        else
          this.emptyPause = {
            tick: loaded.combat.tick,
            runEpoch: loaded.snapshot.runEpoch,
            hash: combatRuntimeHash(loaded),
          };
      } else if (loaded) await this.restoreCombat(loaded);
      else await this.combatStore.initialize(initial);
      this.alarmAtMs = await this.ctx.storage.getAlarm();
      // getAlarm() is null while the alarm itself is running; let that handler own rescheduling.
      if (
        this.world.roomMode !== "expired" &&
        this.alarmAtMs === null &&
        this.alarmDeliveries === 0
      )
        await this.scheduleExpiry();
    } else
      this.identity = Promise.resolve(
        this.workload === "controller" ? CONTROLLER_IDENTITY : PROBE_IDENTITY,
      );
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    let action = parts[2];
    this.initialization ??= this.ctx.blockConcurrencyWhile(() => this.initialize(parts[1]));
    await this.initialization;
    this.resolvedIdentity = await this.identity;
    const profileId = request.headers.get("X-Edgefall-Profile") ?? "";
    let hostCommand: HostCommand | null = null;
    const requireHost = () => {
      if (!this.members || !hostCommand) throw new Error("host-required");
      const member = this.members.state.members.find((m) => m.profileId === profileId);
      const peer = member && this.peers.get(member.slot);
      if (!member || !peer?.metrics.active || peer.generation !== member.generation)
        throw new Error("stale-host-command");
      requireCurrentHost(
        this.members.state,
        profileId,
        this.world.runEpoch,
        this.context(member.slot).connectionEpoch,
        hostCommand,
      );
    };
    if (action === "session") {
      if (
        request.method !== "GET" ||
        !this.members?.state.members.some((m) => m.profileId === profileId)
      )
        return Response.json({ code: "member-required" }, { status: 403 });
      return Response.json(
        roomControlState(this.members.state, this.world.roomMode, this.world.runEpoch),
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (action === "control") {
      try {
        hostCommand = await readHostCommand(request);
      } catch (error) {
        return Response.json(
          { code: "invalid-command", detail: String(error).slice(0, 128) },
          { status: 400 },
        );
      }
      try {
        requireHost();
      } catch (error) {
        const code = error instanceof Error ? error.message : "host-required";
        return Response.json({ code }, { status: code === "host-required" ? 403 : 409 });
      }
      action = hostCommand.command;
      if (action !== "load" && action !== "start" && action !== "continue")
        return Response.json({ code: "command-unavailable" }, { status: 409 });
    } else if (this.workload === "combat" && ["start", "load", "continue"].includes(action ?? ""))
      return Response.json({ code: "host-command-required" }, { status: 401 });
    if (action === "disconnect-peer") {
      const slot = Number(url.searchParams.get("slot"));
      const peer = this.peers.get(slot);
      if (
        request.method !== "POST" ||
        this.workload !== "combat" ||
        this.world.roomMode !== "playing" ||
        url.searchParams.get("slot") === null ||
        !peer?.metrics.active
      )
        return new Response("Peer unavailable", { status: 409 });
      this.disconnect(peer, "injected-outage", 1012);
      return Response.json({ tick: this.world.tick, slot });
    }
    if (action === "admission") {
      const slot = Number(url.searchParams.get("slot"));
      const reply = (code: string, status = 200) =>
        Response.json(
          {
            code,
            roomMode: this.world.roomMode,
            protocolMajor: PROTOCOL_MAJOR,
            protocolMinor: PROTOCOL_MINOR,
            identity: this.resolvedIdentity,
          },
          { status, headers: { "Cache-Control": "no-store" } },
        );
      if (
        request.method !== "GET" ||
        url.searchParams.get("slot") === null ||
        !Number.isInteger(slot) ||
        slot < 0 ||
        slot > 3 ||
        !this.members
      )
        return reply("protocol-error", 400);
      if (this.world.roomMode === "expired") return reply("room-ended", 410);
      if (
        this.world.roomMode === "recovering" ||
        this.starting ||
        this.admissions.has(slot) ||
        this.pendingPeers.has(slot)
      )
        return reply("outage", 503);
      try {
        admitMember(
          this.members.state,
          request.headers.get("X-Edgefall-Profile") ?? "",
          slot,
          this.admissionPhase(),
          Date.now(),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : "outage";
        return reply(
          reason === "reconnect-window-expired"
            ? "reservation-expired"
            : reason === "slot-reserved"
              ? "room-full"
              : reason === "profile-slot-mismatch"
                ? "profile-required"
                : reason,
          409,
        );
      }
      return reply("ready");
    }
    if (action === "release-write") {
      if (request.method !== "POST" || this.workload !== "combat" || !this.heldPersistence)
        return new Response("No held write", { status: 409 });
      this.heldPersistence.release();
      return Response.json({ released: true });
    }
    if (action === "hold-next-write") {
      if (
        request.method !== "POST" ||
        this.workload !== "combat" ||
        this.world.roomMode !== "playing" ||
        this.heldPersistence ||
        this.holdNextPersistence
      )
        return new Response("Write hold unavailable", { status: 409 });
      this.holdNextPersistence = true;
      return Response.json({ tick: this.world.tick });
    }
    if (action === "fail-next-write") {
      if (
        request.method !== "POST" ||
        this.workload !== "combat" ||
        this.world.roomMode !== "playing"
      )
        return new Response("Fault injection unavailable", { status: 409 });
      this.failNextPersistence = true;
      return Response.json({ tick: this.world.tick, durability: this.combatWriter?.status });
    }
    if (action === "fail-next-tick") {
      if (
        request.method !== "POST" ||
        this.workload !== "combat" ||
        this.world.roomMode !== "playing"
      )
        return new Response("Fault injection unavailable", { status: 409 });
      this.failNextCombatTick = true;
      return Response.json({
        accepted: true,
        tick: this.world.tick,
        acknowledgments: this.world.acknowledgments,
        combat: this.combat,
        events: this.eventHistory?.entries,
        eventCursor: this.eventHistory?.cursor,
      });
    }
    if (action === "recover") {
      if (request.method !== "POST") return new Response("Use POST", { status: 405 });
      if (this.workload === "combat") {
        if (
          this.starting ||
          this.recoveries >= 4 ||
          !["playing", "recovering", "paused-empty"].includes(this.world.roomMode)
        )
          return new Response("Recovery unavailable", { status: 409 });
        this.clock.close();
        this.clearWatchdog();
        this.world.roomMode = "recovering";
        this.disconnectAll("baseline-replaced");
        this.peers.clear();
        this.starting = true;
        try {
          await this.restoreCombat();
        } finally {
          this.starting = false;
        }
        return Response.json({
          runEpoch: this.world.runEpoch,
          tick: this.world.tick,
          roomMode: this.world.roomMode,
          recoveryBoundary: this.recoveryBoundary,
        });
      }
      if (
        this.workload !== "controller" ||
        this.recoveries >= 4 ||
        !["playing", "recovering", "paused-empty"].includes(this.world.roomMode)
      )
        return new Response("Recovery unavailable", { status: 409 });
      // Construct and validate the replacement before invalidating the current generation.
      const restored = recoverControllerWorld(this.world);
      for (const actor of restored.players)
        encodeSnapshot(
          {
            ...restored,
            connectionEpoch: controllerPeerContext(restored, actor.slot).connectionEpoch,
          },
          controllerPeerContext(restored, actor.slot),
        );
      this.clock.close();
      this.clearWatchdog();
      this.disconnectAll("baseline-replaced");
      this.peers.clear();
      this.world = restored;
      this.clock = this.createClock(restored.tick);
      this.recoveries++;
      return Response.json({
        runEpoch: restored.runEpoch,
        tick: restored.tick,
        roomMode: restored.roomMode,
      });
    }
    if (action === "connect") {
      const slot = Number(url.searchParams.get("slot"));
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("Upgrade required", { status: 426 });
      if (url.searchParams.get("slot") === null || !Number.isInteger(slot) || slot < 0 || slot > 3)
        return new Response("Invalid slot", { status: 400 });
      if (this.workload === "combat" && this.world.roomMode === "paused-empty") {
        if (this.starting) return new Response("Pause persistence pending", { status: 503 });
        try {
          if (!this.members) throw new Error("Missing room membership");
          admitMember(
            this.members.state,
            request.headers.get("X-Edgefall-Profile") ?? "",
            slot,
            this.admissionPhase(),
            Date.now(),
          );
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "Admission failed", {
            status: 409,
          });
        }
        this.starting = true;
        try {
          await this.restoreCombat();
          this.peers.clear();
        } finally {
          this.starting = false;
        }
      }
      const replacing = this.workload === "combat" && this.world.roomMode === "playing";
      const waitingReplacement =
        this.workload === "combat" &&
        isWaitingRoom(this.world.roomMode) &&
        (this.peers.has(slot) ||
          (this.world.roomMode === "completed" &&
            this.members?.state.members.some((member) => member.slot === slot)));
      if (
        (replacing || waitingReplacement) &&
        (this.world.players[slot]?.vehicleId !== null ||
          this.context(slot).connectionEpoch >= COUNTER_LIMIT - 2)
      )
        return new Response("Connection transition unavailable", { status: 409 });
      if (
        (!replacing &&
          (!(this.workload === "combat"
            ? isWaitingRoom(this.world.roomMode)
            : this.world.roomMode === "loading") ||
            (!waitingReplacement && this.peers.has(slot)))) ||
        (waitingReplacement && this.admissions.size > 0) ||
        this.admissions.has(slot) ||
        this.pendingPeers.has(slot) ||
        this.starting ||
        this.connections.length >= 32
      )
        return new Response("Room admission unavailable", { status: 409 });
      let generation = 0;
      let settleAdmission = () => {};
      let admissionSucceeded = false;
      let persistingReplacement = false;
      if (this.members) {
        const profileId = request.headers.get("X-Edgefall-Profile") ?? "";
        try {
          const admitted = admitMember(
            this.members.state,
            profileId,
            slot,
            this.admissionPhase(),
            Date.now(),
          );
          generation = admitted.members.find((m) => m.slot === slot)?.generation ?? 0;
          // Waiting replacements mutate the saved boundary; keep start and other claims outside it.
          if (waitingReplacement) this.starting = true;
          let settled = () => {};
          this.admissions.set(
            slot,
            new Promise<void>((resolve) => {
              settled = resolve;
            }),
          );
          settleAdmission = settled;
          const epoch = this.world.runEpoch;
          const phase = this.world.roomMode;
          this.members.save(admitted);
          await this.ctx.storage.sync();
          if (this.world.runEpoch !== epoch || this.world.roomMode !== phase)
            throw new Error("room-boundary-changed");
          if (waitingReplacement) {
            if (!this.combatStore) throw new Error("Missing combat store");
            persistingReplacement = true;
            const replacement = await this.combatStore.replaceWaitingConnection(
              this.combatRuntime(),
              slot + 1,
            );
            if (this.world.runEpoch !== epoch || this.world.roomMode !== phase)
              throw new Error("room-boundary-changed");
            this.installCombat(replacement);
          }
          admissionSucceeded = true;
        } catch (error) {
          if (generation) {
            this.members.save(disconnectMember(this.members.state, slot, generation, Date.now()));
            const previous = this.peers.get(slot);
            if (previous) this.disconnect(previous, "admission-cancelled");
          }
          if (persistingReplacement) this.pausePersistence(String(error));
          return new Response(error instanceof Error ? error.message : "Admission failed", {
            status: 409,
          });
        } finally {
          this.admissions.delete(slot);
          settleAdmission();
          if (waitingReplacement) {
            this.starting = false;
            if (!admissionSucceeded) this.pauseEmpty();
          }
        }
      }
      const pair = new WebSocketPair();
      const peer: Peer = {
        generation,
        initialBaseline: null,
        baselineTick: this.world.tick,
        lastRoomMode: this.world.roomMode,
        inputPauseSnapshotId: null,
        socket: pair[1],
        input: new InputStream({
          ...this.context(slot),
          connectionEpoch: this.context(slot).connectionEpoch + (replacing ? 1 : 0),
          controlEpoch: this.world.players[slot]?.controlEpoch ?? 1,
          baselineServerTick: this.world.tick,
        }),
        lease: null,
        lastAckAt: performance.now(),
        pendingEventBaseline: null,
        eventBeforeBaseline: 0,
        metrics: {
          slot,
          active: true,
          inputFrames: 0,
          inputBytes: 0,
          renewedFrames: 0,
          acknowledgmentOnlyFrames: 0,
          snapshots: 0,
          snapshotBytes: 0,
          inputMappingBytes: 0,
          eventBytes: 0,
          eventFrames: 0,
          eventSentCursor: 0,
          eventBaselines: 0,
          maxQueuedCommands: 0,
          neutralizedAtTick: null,
          expiredAtTick: null,
          closeReason: null,
          lastInputError: null,
          lastOutputError: null,
          lastProcessedSequence: 0,
          lastHeld: 0,
        },
      };
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ instanceId: this.instanceId, slot, generation });
      if (replacing) this.pendingPeers.set(slot, peer);
      else {
        const old = this.peers.get(slot);
        this.peers.set(slot, peer);
        if (old) this.disconnect(old, "connection-replaced", 4003);
        if (waitingReplacement)
          this.connections.push({
            tick: this.world.tick,
            slot,
            connectionEpoch: this.context(slot).connectionEpoch,
            controlEpoch: this.world.players[slot]?.controlEpoch ?? 0,
            baselineEventCursor: this.world.baselineEventCursor,
          });
        this.welcome(peer);
      }
      if (this.members && peer.metrics.active) await this.clearExpiry();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (action !== "status" && request.method !== "POST")
      return new Response("Use POST", { status: 405 });
    if (action === "continue") {
      if (
        this.starting ||
        this.admissions.size ||
        this.world.roomMode !== "intermission" ||
        this.campaign?.state.phase !== "wipe" ||
        !this.combatStore
      )
        return Response.json({ code: "continue-unavailable" }, { status: 409 });
      this.starting = true;
      try {
        const continued = await this.combatStore.transition(
          this.combatRuntime(),
          "continue",
          requireHost,
        );
        requireHost();
        this.installCombat(continued);
        this.combatWriter = null;
        this.clock = this.createClock(continued.combat.tick);
        this.disconnectAll("baseline-replaced");
        this.peers.clear();
        this.emptyPause = null;
      } catch (error) {
        this.pausePersistence(String(error));
        return Response.json({ code: "continue-recovery" }, { status: 503 });
      } finally {
        this.starting = false;
      }
      return Response.json({
        roomMode: this.world.roomMode,
        runEpoch: this.world.runEpoch,
        continuesUsed: this.campaign?.state.continuesUsed,
      });
    }
    if (action === "load") {
      if (
        this.starting ||
        this.admissions.size ||
        !["lobby", "intermission"].includes(this.world.roomMode) ||
        (this.campaign && ["wipe", "defeat"].includes(this.campaign.state.phase)) ||
        !this.combatStore
      )
        return Response.json({ code: "load-unavailable" }, { status: 409 });
      this.starting = true;
      try {
        const phase = this.world.roomMode;
        const loaded = await this.combatStore.transition(this.combatRuntime(), "load", requireHost);
        requireHost();
        if (this.world.roomMode !== phase) throw new Error("room-boundary-changed");
        this.installCombat(loaded);
        for (const peer of this.peers.values()) if (peer.metrics.active) this.publishSnapshot(peer);
      } catch (error) {
        this.pausePersistence(String(error));
        return Response.json({ code: "load-recovery" }, { status: 503 });
      } finally {
        this.starting = false;
      }
      return Response.json({ roomMode: this.world.roomMode });
    }
    if (action === "start") {
      if (
        this.starting ||
        this.admissions.size > 0 ||
        this.world.roomMode !== "loading" ||
        ![...this.peers.values()].some((peer) => peer.metrics.active) ||
        [...this.peers.values()]
          .filter((peer) => peer.metrics.active)
          .some(
            (peer) =>
              !peer.metrics.active ||
              peer.initialBaseline !== null ||
              (this.controllerInputs && peer.input.queuedCommands < CONTROLLER_INPUT_PREFILL_TICKS),
          )
      )
        return new Response("Ready connected clients required", { status: 409 });
      this.starting = true;
      try {
        if (this.workload === "combat") {
          if (!this.combatStore) throw new Error("Missing combat store");
          const started = await this.combatStore.transition(
            this.combatRuntime(),
            "start",
            requireHost,
          );
          requireHost();
          if (this.world.roomMode !== "loading") throw new Error("room-boundary-changed");
          this.installCombat(started);
          this.combatWriter = new CombatJournalWriter(
            { commit: (start, entries, accepted) => this.persistCombat(start, entries, accepted) },
            started,
            (reason) => this.pausePersistence(reason),
            (work) => this.ctx.waitUntil(work),
          );
        }
      } catch (error) {
        this.pausePersistence(String(error));
        return new Response("Combat start persistence failed", { status: 503 });
      } finally {
        this.starting = false;
      }
      if (![...this.peers.values()].some((peer) => peer.metrics.active)) {
        this.pauseEmpty();
        return new Response("Start cohort changed", { status: 409 });
      }
      const now = performance.now();
      for (const peer of this.peers.values()) {
        if (!peer.metrics.active) continue;
        peer.lease = new ControlLease(now);
        peer.lastAckAt = now;
      }
      this.world.roomMode = "playing";
      if (this.controllerInputs) {
        // Announce the start boundary before the first tick; clients retain their preloaded lead.
        this.world.stateHash = roomWorkloadHash(this.world);
        for (const peer of this.peers.values()) this.publishSnapshot(peer);
      }
      this.watchdog = setTimeout(() => this.finish("wall-limit"), 20_000);
      this.startedAtTick = this.world.tick;
      this.clock.start();
    } else if (action === "close") this.finish("observer-closed");
    else if (action !== "status") return new Response("Not found", { status: 404 });
    const status: RoomProbeStatus = {
      emptyPause: this.emptyPause,
      alarmAtMs: this.alarmAtMs,
      alarmDeliveries: this.alarmDeliveries,
      pausedFrom: this.pausedFrom,
      connections: this.connections,
      staleSocketEvents: this.staleSocketEvents,
      membership: this.members
        ? {
            epoch: this.members.state.epoch,
            hostSlot: this.members.state.hostSlot,
            members: this.members.state.members.map(({ profileId: _private, ...member }) => member),
          }
        : null,
      instanceId: this.instanceId,
      worldFailure: this.worldFailure,
      durability: this.combatWriter?.status ?? null,
      persistenceFailure: this.persistenceFailure,
      persistenceHeld: this.heldPersistence !== null,
      persistenceCommits: this.combatStore?.commits ?? [],
      recoveryBoundary: this.recoveryBoundary,
      inputStreams: [...this.peers.values()].map((peer) => ({
        acknowledgment: peer.input.acknowledgment,
        queued: peer.input.queuedCommands,
        requiresResync: peer.input.requiresResync,
        delivery: peer.input.deliveryAcknowledgments,
        pendingEventBaseline: peer.pendingEventBaseline,
        initialBaseline: peer.initialBaseline,
      })),
      combat:
        this.combat && this.campaign
          ? {
              world: this.combat,
              campaign: this.campaign,
              events: this.eventHistory?.entries ?? [],
              eventCursor: this.eventHistory?.cursor ?? 0,
              droppedEvents: this.eventHistory?.capEvictions ?? 0,
              ageEvictions: this.eventHistory?.ageEvictions ?? 0,
            }
          : null,
      runEpoch: this.world.runEpoch,
      recoveries: this.recoveries,
      workload: this.workload,
      tick: this.world.tick,
      roomMode: this.world.roomMode,
      clock: this.clock.state,
      watchdogPending: this.watchdog !== null,
      peers: [...this.peers.values()].map((peer) => ({ ...peer.metrics })),
      inputTimeline: this.inputTimeline,
      localCpu: this.localCpu,
      callbacks: this.callbacks,
      timers: this.timers,
    };
    return Response.json(status);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const peer = [...this.peers.values()].find((value) => value.socket === socket);
    if (
      !peer?.metrics.active ||
      (isWaitingRoom(this.world.roomMode) && this.admissions.has(peer.metrics.slot))
    ) {
      this.staleSocketEvents = Math.min(1000, this.staleSocketEvents + 1);
      return;
    }
    if (
      (typeof message === "string" ? message.length > 512 : message.byteLength > 284) ||
      (this.world.roomMode !== "playing" &&
        !(this.controllerInputs && isWaitingRoom(this.world.roomMode)))
    ) {
      this.disconnect(peer, "invalid-input", 4004);
      return;
    }
    const now = performance.now();
    if (this.world.roomMode === "playing" && (!peer.lease || peer.lease.expired(now))) {
      this.disconnect(peer, "lease-expired");
      return;
    }
    let firstSequence = 0,
      lastSequence = 0;
    try {
      if (typeof message === "string") {
        if (this.workload !== "combat" || peer.initialBaseline)
          throw new Error("Unexpected event control");
        const request = decodeEventResyncRequest(message, this.context(peer.metrics.slot));
        if (
          request.lastEventCursor < peer.input.deliveryAcknowledgments.event ||
          request.lastEventCursor > peer.metrics.eventSentCursor
        )
          throw new Error("Invalid event repair cursor");
        this.publishSnapshot(peer, "client-gap");
        return;
      }
      const previousAck = peer.input.deliveryAcknowledgments.snapshot;
      const batch = decodeInputBatch(new Uint8Array(message), this.context(peer.metrics.slot));
      const drainPaused =
        this.world.roomMode === "intermission" &&
        this.campaign &&
        ["wipe", "defeat"].includes(this.campaign.state.phase) &&
        !peer.initialBaseline &&
        (peer.inputPauseSnapshotId === null || batch.snapshotAck < peer.inputPauseSnapshotId);
      if (
        this.world.roomMode !== "loading" &&
        this.world.roomMode !== "playing" &&
        batch.commands.length &&
        !drainPaused
      )
        throw new Error("Room phase accepts acknowledgments only");
      if (
        peer.initialBaseline &&
        (batch.snapshotAck !== peer.initialBaseline.snapshotId ||
          batch.eventAck !== peer.initialBaseline.cursor)
      )
        throw new Error("Fresh baseline acknowledgment required");
      if (this.controllerInputs) {
        firstSequence = batch.commands[0]?.sequence ?? 0;
        lastSequence = batch.commands.at(-1)?.sequence ?? 0;
      }
      const eventBaselineAccepted = acceptsEventBaseline(
        peer.pendingEventBaseline,
        batch.snapshotAck,
        batch.eventAck,
        peer.eventBeforeBaseline,
      );
      const result = peer.input.receive(
        new Uint8Array(message),
        now,
        this.clock.state.tick,
        drainPaused ? "drain-paused" : "active",
      );
      if (!result.duplicate) peer.initialBaseline = null;
      if (peer.lastRoomMode !== this.world.roomMode) this.publishSnapshot(peer);
      if (eventBaselineAccepted && !result.duplicate) peer.pendingEventBaseline = null;
      this.traceInput(
        peer,
        "admit",
        now,
        this.clock.state.tick,
        firstSequence,
        lastSequence,
        result.duplicate
          ? "duplicate"
          : drainPaused && batch.commands.length
            ? "discarded-after-pause"
            : "admitted",
      );
      peer.metrics.inputFrames++;
      peer.metrics.inputBytes += message.byteLength;
      if (result.admitted === 0 && !result.duplicate) peer.metrics.acknowledgmentOnlyFrames++;
      if (peer.lease?.observeAdmission(result, now)) peer.metrics.renewedFrames++;
      if (peer.input.deliveryAcknowledgments.snapshot > previousAck) peer.lastAckAt = now;
      peer.metrics.maxQueuedCommands = Math.max(
        peer.metrics.maxQueuedCommands,
        peer.input.queuedCommands,
      );
    } catch (error) {
      peer.metrics.lastInputError = (error instanceof Error ? error.message : String(error)).slice(
        0,
        256,
      );
      this.traceInput(
        peer,
        "reject",
        now,
        this.clock.state.tick,
        firstSequence,
        lastSequence,
        peer.metrics.lastInputError,
      );
      this.disconnect(peer, "invalid-input", 4004);
    }
  }
  webSocketClose(socket: WebSocket): void {
    const peer = [...this.peers.values()].find((value) => value.socket === socket);
    if (peer) this.disconnect(peer, "socket-closed");
    else {
      const pending = [...this.pendingPeers.values()].find((value) => value.socket === socket);
      if (pending) {
        this.disconnect(pending, "socket-closed");
        this.pendingPeers.delete(pending.metrics.slot);
        const previous = this.peers.get(pending.metrics.slot);
        if (previous) this.disconnect(previous, "admission-cancelled");
      } else this.staleSocketEvents = Math.min(1000, this.staleSocketEvents + 1);
    }
  }
  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response("Local only", { status: 403 });
    if (url.pathname === "/health") return Response.json({ fixture: "edgefall-room-load-probe" });
    const origin = request.headers.get("Origin");
    if (origin) {
      try {
        const source = new URL(origin);
        if (
          source.protocol !== "http:" ||
          !["localhost", "127.0.0.1"].includes(source.hostname) ||
          source.origin !== origin
        )
          return new Response("Local origin required", { status: 403 });
      } catch {
        return new Response("Invalid origin", { status: 403 });
      }
    }
    if (url.pathname === "/profile") {
      if (request.method !== "POST") return new Response("Use POST", { status: 405 });
      const now = Math.floor(Date.now() / 1000);
      const existing = await verifyProfileIdentity(
        profileCookie(request.headers.get("Cookie")),
        env.PROFILE_COOKIE_SECRET,
        now,
      );
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Credentials", "true");
        headers.set("Vary", "Origin");
      }
      if (!existing)
        headers.set(
          "Set-Cookie",
          `${PROFILE_COOKIE_NAME}=${await signProfileIdentity(crypto.randomUUID(), now + 3600, env.PROFILE_COOKIE_SECRET)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
        );
      return Response.json({ authenticated: true }, { headers });
    }
    const match =
      /^\/(standard|double|controller|combat)\/(session|control|admission|connect|start|status|close|recover|disconnect-peer|fail-next-tick|fail-next-write|hold-next-write|release-write)$/u.exec(
        url.pathname,
      );
    if (!match?.[1]) return new Response("Not found", { status: 404 });
    const forwarded = new Request(request);
    forwarded.headers.delete("X-Edgefall-Profile");
    const cors = (response: Response) => {
      if (origin && ["admission", "session", "control"].includes(match[2] ?? "")) {
        response.headers.set("Access-Control-Allow-Origin", origin);
        response.headers.set("Access-Control-Allow-Credentials", "true");
        response.headers.set("Vary", "Origin");
      }
      return response;
    };
    if (
      match[1] === "combat" &&
      ["connect", "admission", "session", "control"].includes(match[2] ?? "")
    ) {
      if (request.method !== (match[2] === "control" ? "POST" : "GET"))
        return new Response("Method not allowed", { status: 405 });
      const profile = await verifyProfileIdentity(
        profileCookie(request.headers.get("Cookie")),
        env.PROFILE_COOKIE_SECRET,
        Math.floor(Date.now() / 1000),
      );
      if (!profile) return cors(Response.json({ code: "profile-required" }, { status: 401 }));
      forwarded.headers.set("X-Edgefall-Profile", profile);
    }
    const response = await env.ROOM_PROBES.getByName(match[1]).fetch(forwarded);
    return ["admission", "session", "control"].includes(match[2] ?? "")
      ? cors(new Response(response.body, response))
      : response;
  },
};
