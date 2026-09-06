import { DurableObject } from "cloudflare:workers";
import type { AppliedInput } from "../../game/input/types.js";
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
import type { Handshake } from "../../shared/protocol/handshake.js";
import { InputStream } from "../../shared/protocol/input-stream.js";
import { encodeSnapshot } from "../../shared/protocol/snapshot.js";
import { RoomClock } from "../../shared/runtime/room-clock.js";
import { ControlLease } from "../runtime/control-lease.js";

interface ProbeEnv {
  ROOM_PROBES: DurableObjectNamespace<RoomLoadProbe>;
}
interface Peer {
  socket: WebSocket;
  input: InputStream;
  lease: ControlLease | null;
  lastAckAt: number;
  metrics: PeerMetrics;
}

/** Separate loopback diagnostics only: synthetic load and the real controller workload. */
export class RoomLoadProbe extends DurableObject<ProbeEnv> {
  private readonly instanceId = crypto.randomUUID();
  private workload: "standard" | "double" | "controller" = "standard";
  private world = createRoomWorkload(1);
  private readonly peers = new Map<number, Peer>();
  private readonly localCpu: RoomProbeStatus["localCpu"] = [];
  private readonly callbacks: RoomProbeStatus["callbacks"] = [];
  private readonly timers: RoomProbeStatus["timers"] = [];
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
      step: (tick) => this.step(tick),
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
    peer.socket.close(code, reason);
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
    return this.workload === "controller"
      ? controllerPeerContext(this.world, slot)
      : probeContext(slot);
  }

  private snapshot(peer: Peer): void {
    this.world.snapshotId++;
    const context = this.context(peer.metrics.slot);
    this.world.connectionEpoch = context.connectionEpoch;
    const bytes = encodeSnapshot(this.world, context);
    peer.socket.send(bytes);
    peer.input.recordSent(this.world.snapshotId, 0);
    peer.metrics.snapshots++;
    peer.metrics.snapshotBytes += bytes.byteLength;
  }

  private step(tick: number): undefined {
    const cpuStart = performance.now(); // Local CPU diagnostic only; never enters world arithmetic.
    const inputs: AppliedInput[] = [];
    if (this.workload !== "controller") for (const actor of this.world.players) actor.body.vx = 0;
    for (const [slot, peer] of [...this.peers].sort(([a], [b]) => a - b)) {
      if (!peer.metrics.active) continue;
      if (peer.lease?.expired(this.sampledNow)) {
        this.disconnect(peer, "lease-expired", 4001, tick);
        continue;
      }
      if (this.sampledNow - peer.lastAckAt >= 1000) {
        this.disconnect(peer, "reader-stalled", 4002);
        continue;
      }
      const processed = peer.input.processTick(tick, this.sampledNow, (input) => {
        inputs.push(input);
        if (this.workload === "controller") {
          const actor = this.world.players[slot];
          if (!actor) throw new Error("Missing controller actor");
          const result = stepNetworkController(
            actor,
            { ...input.command, controlEpoch: actor.controlEpoch },
            tick,
          );
          this.world.players[slot] = result.actor;
          return result.edges;
        }
        // The synthetic fixture has no combat; rejected edges must still be acknowledged.
        return input.command.edges.map((edge) => ({ ...edge, outcome: "unavailable" as const }));
      });
      this.world.acknowledgments[slot] = processed.acknowledgment;
      const actor = this.world.players[slot];
      if (!actor) throw new Error("Missing probe actor");
      actor.processedEdgeIds = [...processed.acknowledgment.processedEdgeIds];
      peer.metrics.lastHeld = processed.input.command.held;
      peer.metrics.lastProcessedSequence = processed.acknowledgment.lastProcessedSequence;
      if (processed.neutralized && peer.metrics.neutralizedAtTick === null)
        peer.metrics.neutralizedAtTick = tick;
    }
    if (this.workload === "controller") {
      for (const [slot, peer] of this.peers)
        if (!peer.metrics.active) {
          const actor = this.world.players[slot];
          if (actor)
            this.world.players[slot] = stepNetworkController(
              actor,
              {
                sequence: 0,
                clientTick: 0,
                controlEpoch: actor.controlEpoch,
                held: 0,
                aim: 0,
                edges: [],
              },
              tick,
            ).actor;
        }
      this.world.tick = tick;
    } else stepRoomWorkload(this.world, tick, inputs);
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
        if (peer.metrics.active && this.sampledNow - peer.lastAckAt < 500) this.snapshot(peer);
      }
      encodeMs = performance.now() - encodeStart;
    }
    if (this.localCpu.length < 1200)
      this.localCpu.push([tick, performance.now() - cpuStart, encodeMs]);
    if (tick >= 1200) this.finish("tick-limit");
  }

  fetch(request: Request): Response {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const action = parts[2];
    if (!this.initialized) {
      this.initialized = true;
      this.workload =
        parts[1] === "controller" ? "controller" : parts[1] === "double" ? "double" : "standard";
      this.world =
        this.workload === "controller"
          ? createControllerWorkload()
          : createRoomWorkload(this.workload === "double" ? 2 : 1);
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
          maxQueuedCommands: 0,
          neutralizedAtTick: null,
          expiredAtTick: null,
          closeReason: null,
          lastInputError: null,
          lastProcessedSequence: 0,
          lastHeld: 0,
        },
      };
      this.peers.set(slot, peer);
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ instanceId: this.instanceId, slot });
      const welcome: Handshake = {
        ...(this.workload === "controller" ? CONTROLLER_IDENTITY : PROBE_IDENTITY),
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
        capabilities: 0,
        baselineSnapshotId: this.world.snapshotId + 1,
        baselineEventCursor: 0,
        buildId: "4".repeat(64),
      };
      pair[1].send(JSON.stringify(welcome));
      this.world.stateHash = roomWorkloadHash(this.world);
      this.snapshot(peer);
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
            (this.workload === "controller" &&
              peer.input.queuedCommands < CONTROLLER_INPUT_PREFILL_TICKS),
        )
      )
        return new Response("Four clients required", { status: 409 });
      const now = performance.now();
      for (const peer of this.peers.values()) {
        peer.lease = new ControlLease(now);
        peer.lastAckAt = now;
      }
      this.world.roomMode = "playing";
      if (this.workload === "controller") {
        // Announce the start boundary before the first tick; clients retain their preloaded lead.
        this.world.stateHash = roomWorkloadHash(this.world);
        for (const peer of this.peers.values()) this.snapshot(peer);
      }
      this.watchdog = setTimeout(() => this.finish("wall-limit"), 20_000);
      this.clock.start();
    } else if (action === "close") this.finish("observer-closed");
    else if (action !== "status") return new Response("Not found", { status: 404 });
    const status: RoomProbeStatus = {
      instanceId: this.instanceId,
      runEpoch: this.world.runEpoch,
      recoveries: this.recoveries,
      workload: this.workload,
      tick: this.world.tick,
      roomMode: this.world.roomMode,
      clock: this.clock.state,
      watchdogPending: this.watchdog !== null,
      peers: [...this.peers.values()].map((peer) => ({ ...peer.metrics })),
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
        !(this.workload === "controller" && this.world.roomMode === "loading"))
    ) {
      this.disconnect(peer, "invalid-input", 4004);
      return;
    }
    const now = performance.now();
    if (this.world.roomMode === "playing" && (!peer.lease || peer.lease.expired(now))) {
      this.disconnect(peer, "lease-expired");
      return;
    }
    try {
      const previousAck = peer.input.deliveryAcknowledgments.snapshot;
      const result = peer.input.receive(new Uint8Array(message), now, this.clock.state.tick);
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
    const match = /^\/(standard|double|controller)\/(connect|start|status|close|recover)$/u.exec(
      url.pathname,
    );
    if (!match?.[1]) return new Response("Not found", { status: 404 });
    return env.ROOM_PROBES.getByName(match[1]).fetch(request);
  },
};
