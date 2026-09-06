import { DurableObject } from "cloudflare:workers";
import type { CombatLab, CombatNotice } from "../../game/labs/combat.js";
import type { GameIdentity } from "../../shared/content-id.js";
import {
  combatIdentity,
  createCombatWorkload,
  evaluateCombatTick,
} from "../../shared/diagnostics/combat-workload.js";
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
import type { Handshake } from "../../shared/protocol/handshake.js";
import {
  INPUT_MAPPING_CAPABILITY,
  mappingForSnapshot,
} from "../../shared/protocol/input-mapping.js";
import type { WorldInputOutcome } from "../../shared/protocol/input-stream.js";
import { InputStream } from "../../shared/protocol/input-stream.js";
import { encodeSnapshot } from "../../shared/protocol/snapshot.js";
import { RoomClock } from "../../shared/runtime/room-clock.js";
import { ControlLease } from "../runtime/control-lease.js";

interface ProbeEnv {
  ROOM_PROBES: DurableObjectNamespace<RoomLoadProbe>;
}
interface Peer {
  baselineTick: number;
  socket: WebSocket;
  input: InputStream;
  lease: ControlLease | null;
  lastAckAt: number;
  metrics: PeerMetrics;
}

/** Separate loopback diagnostics only: synthetic load and the real controller workload. */
export class RoomLoadProbe extends DurableObject<ProbeEnv> {
  private readonly instanceId = crypto.randomUUID();
  private workload: "standard" | "double" | "controller" | "combat" = "standard";
  private world = createRoomWorkload(1);
  private combat: CombatLab | null = null;
  private readonly combatEvents: Array<{ tick: number; counter: number; event: CombatNotice }> = [];
  private combatEventsDropped = 0;
  private identity: Promise<GameIdentity> = Promise.resolve(PROBE_IDENTITY);
  private failNextCombatTick = false;
  private worldFailure: string | null = null;
  private readonly peers = new Map<number, Peer>();
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
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
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
    // Recovery is deliberately not faked by recreating empty input streams after a wake.
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
    if (reason === "lease-expired") peer.metrics.expiredAtTick = decisionTick;
    try {
      peer.socket.close(code, reason);
    } catch (error) {
      peer.metrics.lastOutputError ??= String(error).slice(0, 256);
    }
  }
  private disconnectAll(reason: string): void {
    for (const peer of this.peers.values()) this.disconnect(peer, reason, 4003);
  }
  private finish(reason: string): void {
    this.clock.close();
    this.clearWatchdog();
    this.world.roomMode = "expired";
    this.disconnectAll(reason);
  }

  private context(slot: number) {
    return this.controllerInputs ? controllerPeerContext(this.world, slot) : probeContext(slot);
  }

  private snapshot(peer: Peer): void {
    this.world.snapshotId++;
    const context = this.context(peer.metrics.slot);
    this.world.connectionEpoch = context.connectionEpoch;
    const bytes = encodeSnapshot(this.world, context);
    if (this.controllerInputs) {
      const mapping = JSON.stringify(mappingForSnapshot(this.world, context.playerId));
      peer.socket.send(mapping);
      peer.metrics.inputMappingBytes += new TextEncoder().encode(mapping).byteLength;
    }
    peer.socket.send(bytes);
    peer.input.recordSent(this.world.snapshotId, 0);
    peer.metrics.snapshots++;
    peer.metrics.snapshotBytes += bytes.byteLength;
  }

  private publishSnapshot(peer: Peer): void {
    try {
      this.snapshot(peer);
    } catch (error) {
      // Delivery failure cannot turn an already committed world tick into a failed clock step.
      peer.metrics.lastOutputError = String(error).slice(0, 256);
      this.disconnect(peer, "snapshot-failed", 4002);
    }
  }

  private step(tick: number): undefined {
    const cpuStart = performance.now(); // Local CPU diagnostic only; never enters world arithmetic.
    const active = [...this.peers]
      .sort(([a], [b]) => a - b)
      .filter(([, peer]) => {
        if (!peer.metrics.active) return false;
        if (peer.lease?.expired(this.sampledNow))
          this.disconnect(peer, "lease-expired", 4001, tick);
        else if (this.sampledNow - peer.lastAckAt >= 1000)
          this.disconnect(peer, "reader-stalled", 4002);
        return peer.metrics.active;
      });
    const transaction = InputStream.processWorldTick(
      active.map(([, peer]) => peer.input),
      tick,
      this.sampledNow,
      (prepared) => {
        if (this.workload === "combat") {
          if (!this.combat) throw new Error("Missing combat world");
          const result = evaluateCombatTick(this.combat, this.world, prepared);
          for (const [slot] of active) {
            const context = this.context(slot);
            encodeSnapshot(
              { ...result.state.snapshot, connectionEpoch: context.connectionEpoch },
              context,
            );
          }
          if (this.failNextCombatTick) {
            this.failNextCombatTick = false;
            throw new Error("injected-combat-commit-failure");
          }
          return result;
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
        return { state: { snapshot: candidate, combat: this.combat }, outcomes };
      },
    );
    this.world = transaction.state.snapshot;
    this.combat = transaction.state.combat;
    if (this.combat) {
      const retained = this.combatEvents.filter((item) => item.tick > tick - 120);
      this.combatEvents.splice(0, this.combatEvents.length, ...retained);
      for (const [counter, event] of this.combat.events.entries())
        this.combatEvents.push({ tick, counter, event });
      if (this.combatEvents.length > 512) {
        this.combatEventsDropped += this.combatEvents.length - 512;
        this.combatEvents.splice(0, this.combatEvents.length - 512);
      }
    }
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
    if (![...this.peers.values()].some((peer) => peer.metrics.active)) {
      this.world.roomMode = "paused-empty";
      this.clock.stop();
      this.clearWatchdog();
    }
    let encodeMs = 0;
    if (tick % 3 === 0) {
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
    if (tick >= 1200) this.finish("tick-limit");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const action = parts[2];
    if (!this.initialized) {
      this.initialized = true;
      this.workload =
        parts[1] === "combat"
          ? "combat"
          : parts[1] === "controller"
            ? "controller"
            : parts[1] === "double"
              ? "double"
              : "standard";
      this.world =
        this.workload === "controller"
          ? createControllerWorkload()
          : createRoomWorkload(this.workload === "double" ? 2 : 1);
      if (this.workload === "combat") {
        const initial = createCombatWorkload();
        this.world = initial.snapshot;
        this.combat = initial.combat;
        this.identity = combatIdentity();
      } else
        this.identity = Promise.resolve(
          this.workload === "controller" ? CONTROLLER_IDENTITY : PROBE_IDENTITY,
        );
    }
    const identity = await this.identity;
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
        events: this.combatEvents,
      });
    }
    if (action === "recover") {
      if (request.method !== "POST") return new Response("Use POST", { status: 405 });
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
      if (this.world.roomMode !== "loading" || this.peers.has(slot))
        return new Response("Probe full or started", { status: 409 });
      const pair = new WebSocketPair();
      const peer: Peer = {
        baselineTick: this.world.tick,
        socket: pair[1],
        input: new InputStream({
          ...this.context(slot),
          controlEpoch: this.world.players[slot]?.controlEpoch ?? 1,
          baselineServerTick: this.world.tick,
        }),
        lease: null,
        lastAckAt: performance.now(),
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
      this.peers.set(slot, peer);
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ instanceId: this.instanceId, slot });
      const welcome: Handshake = {
        ...identity,
        type: "welcome",
        protocolMajor: 3,
        protocolMinor: 0,
        runId: "local-room-workload",
        runEpoch: this.world.runEpoch,
        connectionEpoch: this.context(slot).connectionEpoch,
        playerId: slot + 1,
        entityId: slot + 1,
        simulationHz: 60,
        snapshotHz: 20,
        initialServerTick: this.world.tick,
        capabilities: this.controllerInputs ? INPUT_MAPPING_CAPABILITY : 0,
        baselineSnapshotId: this.world.snapshotId + 1,
        baselineEventCursor: 0,
        buildId: "4".repeat(64),
      };
      pair[1].send(JSON.stringify(welcome));
      this.world.stateHash = roomWorkloadHash(this.world);
      this.publishSnapshot(peer);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (action !== "status" && request.method !== "POST")
      return new Response("Use POST", { status: 405 });
    if (action === "start") {
      if (
        this.world.roomMode !== "loading" ||
        this.peers.size !== 4 ||
        [...this.peers.values()].some(
          (peer) =>
            !peer.metrics.active ||
            (this.controllerInputs && peer.input.queuedCommands < CONTROLLER_INPUT_PREFILL_TICKS),
        )
      )
        return new Response("Four clients required", { status: 409 });
      const now = performance.now();
      for (const peer of this.peers.values()) {
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
      this.clock.start();
    } else if (action === "close") this.finish("observer-closed");
    else if (action !== "status") return new Response("Not found", { status: 404 });
    const status: RoomProbeStatus = {
      instanceId: this.instanceId,
      worldFailure: this.worldFailure,
      inputStreams: [...this.peers.values()].map((peer) => ({
        acknowledgment: peer.input.acknowledgment,
        queued: peer.input.queuedCommands,
        requiresResync: peer.input.requiresResync,
      })),
      combat: this.combat
        ? { world: this.combat, events: this.combatEvents, droppedEvents: this.combatEventsDropped }
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
    if (!peer?.metrics.active) return;
    if (
      typeof message === "string" ||
      message.byteLength > 284 ||
      (this.world.roomMode !== "playing" &&
        !(this.controllerInputs && this.world.roomMode === "loading"))
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
      const previousAck = peer.input.deliveryAcknowledgments.snapshot;
      if (this.controllerInputs) {
        const batch = decodeInputBatch(new Uint8Array(message), this.context(peer.metrics.slot));
        firstSequence = batch.commands[0]?.sequence ?? 0;
        lastSequence = batch.commands.at(-1)?.sequence ?? 0;
      }
      const result = peer.input.receive(new Uint8Array(message), now, this.clock.state.tick);
      this.traceInput(
        peer,
        "admit",
        now,
        this.clock.state.tick,
        firstSequence,
        lastSequence,
        result.duplicate ? "duplicate" : "admitted",
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
  }
  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }
}

export default {
  fetch(request: Request, env: ProbeEnv): Response | Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response("Local only", { status: 403 });
    if (url.pathname === "/health") return Response.json({ fixture: "edgefall-room-load-probe" });
    const match =
      /^\/(standard|double|controller|combat)\/(connect|start|status|close|recover|fail-next-tick)$/u.exec(
        url.pathname,
      );
    if (!match?.[1]) return new Response("Not found", { status: 404 });
    return env.ROOM_PROBES.getByName(match[1]).fetch(request);
  },
};
