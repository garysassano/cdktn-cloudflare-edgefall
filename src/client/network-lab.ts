import Phaser from "phaser";
import { shieldPresentation } from "../game/actors/shield.js";
import { firearmPoseTimeline } from "../game/combat/firearm-aim.js";
import { actionPose } from "../game/combat/timeline.js";
import { stateHash } from "../game/core/canonical.js";
import { Edge, Held, type InputCommand, directionalIntent } from "../game/input/types.js";
import {
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  GRENADE_PROFILE,
  SHIELD_PROFILE,
} from "../game/labs/combat-content.js";
import { FOOT_SHAPES } from "../game/labs/foot-fixture.js";
import { worldRect, worldSocket } from "../game/physics/body.js";
import { combatEventContext } from "../shared/diagnostics/combat-events.js";
import { combatContinuationHash } from "../shared/diagnostics/combat-recovery.js";
import {
  COMBAT_SHAPE_IDS,
  COMBAT_TERRAIN,
  combatIdentity,
  predictCombatMovement,
} from "../shared/diagnostics/combat-workload.js";
import {
  CONTROLLER_IDENTITY,
  CONTROLLER_INPUT_PREFILL_TICKS,
  CONTROLLER_TERRAIN,
  stepNetworkController,
} from "../shared/diagnostics/controller-workload.js";
import { probeContext, roomWorkloadHash } from "../shared/diagnostics/room-workload.js";
import { type InputBinding, InputCapture, inputSequenceLimit } from "../shared/input/capture.js";
import { ControllerPrediction } from "../shared/prediction/controller.js";
import { decodeInitialSnapshot } from "../shared/protocol/baseline.js";
import { encodeInputBatch } from "../shared/protocol/codec.js";
import { EventReceiver } from "../shared/protocol/event-stream.js";
import {
  EVENT_CAPABILITY,
  EVENT_TYPE,
  type EventBaseline,
  type EventEnvelope,
  type GameplayEvent,
  decodeEventBaseline,
  decodeEventBatch,
} from "../shared/protocol/events.js";
import { type Handshake, decodeHandshake } from "../shared/protocol/handshake.js";
import {
  INPUT_MAPPING_CAPABILITY,
  type InputMapping,
  decodeInputMapping,
} from "../shared/protocol/input-mapping.js";
import { ProtocolError } from "../shared/protocol/schema.js";
import { decodeSnapshot } from "../shared/protocol/snapshot.js";
import type { FullSnapshot } from "../shared/protocol/snapshot-schema.js";
import { RoomClock } from "../shared/runtime/room-clock.js";
import { requireRoomAdmission } from "../shared/session/admission.js";
import {
  RoomConnectError,
  RoomSocketConnection,
  connectionText,
} from "../shared/session/connection.js";
import {
  type HostAction,
  type HostCommand,
  readRoomControlState,
} from "../shared/session/room-control.js";
import { browserConnectionPort } from "./connection-port.js";
import { drawTankOverlay } from "./tank-overlay.js";

async function startLab() {
  const params = new URL(location.href).searchParams,
    base = new URL(params.get("room") ?? "http://127.0.0.1:8791");
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname))
    throw new Error("Loopback room required");
  const slot = Number(params.get("slot") ?? "0");
  const mode = params.get("mode") === "combat" ? "combat" : "controller";
  const identity = mode === "combat" ? await combatIdentity() : CONTROLLER_IDENTITY;
  const terrain = mode === "combat" ? COMBAT_TERRAIN : CONTROLLER_TERRAIN;
  if (mode === "combat") {
    const title = document.querySelector("h1");
    if (title) title.textContent = "Network combat laboratory";
    const intro = document.getElementById("intro");
    if (intro)
      intro.textContent =
        "Engineering graphics. Four browsers share one authoritative combat world. Cyan predicts movement on foot; tanks, enemies, projectiles and ammo use committed snapshots. Confirmed hit/shot markers use acknowledged, deduplicated events. Predicted effects, final audio and remote interpolation remain in progress.";
    const controls = document.getElementById("controls");
    if (controls)
      controls.textContent =
        "Arrows/WASD move and aim, Space jumps, Z fires or uses the knife near exposed infantry, C throws a grenade on foot. E boards or exits a tank; tank direction slews its turret, Space makes a short jump and Z fires its unlimited primary gun. Armor pips and entry/exit progress appear above and below the hull. Uncheck scripted input to use the keyboard. Filled yellow boxes show shotgun reach; filled orange/red boxes show attached/traveling flame. Outlined yellow boxes show knife reach or bash windup; red marks active bashes, orange a raised shield and purple a broken shield. Green circles show grenades and blasts. After room recovery, reconnect all four clients and prepare fresh input before resuming.";
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error("Invalid slot");
  function element<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing ${id}`);
    return el as T;
  }
  if (params.get("scripted") === "1") element<HTMLInputElement>("scripted").checked = true;
  let connection: RoomSocketConnection;
  const automatic = mode === "combat" && params.get("manual") !== "1";
  const documentId = crypto.randomUUID();
  let profileReady = false;
  let lastFailure = "";
  let lastObservedTick = 0;
  const connectionHistory: Array<{
    generation: number;
    runEpoch: number;
    connectionEpoch: number;
    baselineTick: number;
    previousTick: number;
    rewindTicks: number;
  }> = [];
  const connectionStates: Array<{
    phase: string;
    generation: number;
    attempt: number;
    reason: string | null;
    atMs: number;
    detail: string;
  }> = [];
  let welcome: Handshake | null = null,
    snapshot: FullSnapshot | null = null,
    prediction: ControllerPrediction | null = null;
  let initialActor: FullSnapshot["players"][number] | null = null;
  let inputStopped = false;
  let pendingMapping: InputMapping | null = null;
  let eventReceiver: EventReceiver | null = null;
  let pendingEventBaseline: EventBaseline | null = null;
  let eventRepairRequested = false;
  const eventFaults = { dropNext: 0, pauseUntilBaseline: false, duplicate: false, gapNext: false };
  let eventFramesDropped = 0;
  let eventGapsInjected = 0;
  const eventReceipts: Array<{
    cursor: number;
    tick: number;
    counter: number;
    kind: string;
    origin: string;
    ownerId: number;
    confirmation: GameplayEvent["confirmation"];
    hash: string;
  }> = [];
  const confirmedEffects: EventEnvelope[] = [];
  const eventCounts: Record<string, number> = {};
  let eventHash = "0";
  let input: InputCapture | null = null;
  let inputClock: RoomClock | null = null;
  let packet = 0,
    prepared = false,
    error: string | null = null;
  const receipts: Array<{
    tick: number;
    hash: number;
    bytes: number;
    y: number;
    shape: number;
    ack: number;
    correctionX: number;
    correctionY: number;
    correctionChanged: boolean;
    enemies: number;
    projectiles: number;
    volumes: number;
    vehicles: FullSnapshot["vehicles"];
    platforms: FullSnapshot["platforms"];
    shots: number;
    continuationHash: string | null;
  }> = [];
  const bindings: Record<string, InputBinding> = {
    ArrowLeft: { held: Held.Left },
    KeyA: { held: Held.Left },
    ArrowRight: { held: Held.Right },
    KeyD: { held: Held.Right },
    ArrowUp: { held: Held.Up },
    KeyW: { held: Held.Up },
    ArrowDown: { held: Held.Down },
    KeyS: { held: Held.Down },
    Space: { edge: Edge.Jump },
    KeyZ: { held: Held.Fire, edge: Edge.FireOnset },
    KeyC: { edge: Edge.Grenade },
    KeyX: { edge: Edge.Grenade },
    KeyE: { edge: Edge.Interact },
    KeyV: { held: Held.VehicleSpecial, edge: Edge.VehicleSpecial },
  };
  const surface = element("game");
  surface.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    const binding = bindings[e.code];
    if (!binding) return;
    e.preventDefault();
    // A repeat after blur/reconnect must not recreate intent cleared with the previous session.
    if (e.repeat) return;
    try {
      input?.press(e.code, binding);
    } catch (e) {
      fail(e);
    }
  });
  surface.addEventListener("keyup", (event) => input?.release((event as KeyboardEvent).code));
  function neutral() {
    input?.neutralize();
  }
  function fail(e: unknown) {
    lastFailure = String(e);
    if (automatic && e instanceof ProtocolError && e.code === "resync-required") {
      connection.retry();
      return;
    }
    error ??= lastFailure;
    inputClock?.stop();
    neutral();
    connection?.stop(
      e instanceof ProtocolError && e.code === "identity-mismatch"
        ? "incompatible-build"
        : "protocol-error",
    );
    inspect();
  }
  surface.addEventListener("blur", neutral);
  window.addEventListener("blur", neutral);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) neutral();
  });
  const timeline: Array<{
    kind: string;
    atMs: number;
    sequence: number;
    lastSequence: number;
    snapshotTick: number;
    mappedTick: number;
  }> = [];
  function trace(kind: string, sequence: number, lastSequence: number, mappedTick: number) {
    if (timeline.length < 1800)
      timeline.push({
        kind,
        atMs: performance.now(),
        sequence,
        lastSequence,
        snapshotTick: snapshot?.tick ?? 0,
        mappedTick,
      });
  }
  function status(includeTimeline = false) {
    const actor = prediction?.actor;
    return {
      slot,
      mode,
      documentId,
      connection: connection?.status ?? null,
      connectionHistory,
      connectionStates,
      enemies: snapshot?.enemies ?? [],
      threats: snapshot?.threats ?? [],
      projectiles: snapshot?.projectiles ?? [],
      volumes: snapshot?.combat?.volumes ?? [],
      vehicles: snapshot?.vehicles ?? [],
      platforms: snapshot?.platforms ?? [],
      remainingEnemies: snapshot?.campaign.remainingEnemies ?? null,
      combatBaseline: snapshot?.combat ?? null,
      removedIds: snapshot?.removedIds ?? [],
      events: eventReceiver
        ? {
            ...eventReceiver.status,
            counts: eventCounts,
            hash: eventHash,
            receipts: eventReceipts,
            framesDropped: eventFramesDropped,
            gapsInjected: eventGapsInjected,
            pendingBaseline: pendingEventBaseline,
          }
        : null,
      clockOriginMs: performance.timeOrigin,
      timeline: includeTimeline ? timeline : [],
      runEpoch: welcome?.runEpoch ?? 0,
      connectionEpoch: welcome?.connectionEpoch ?? 0,
      baselineEventCursor: welcome?.baselineEventCursor ?? 0,
      initialActor,
      initialServerTick: welcome?.initialServerTick ?? 0,
      inputStopped,
      ready: welcome !== null && snapshot !== null && connection?.status.phase === "connected",
      roomMode: snapshot?.roomMode ?? null,
      campaign: snapshot?.campaign ?? null,
      prepared,
      error,
      requiresResync: Boolean(
        prediction?.requiresResync ||
          input?.requiresResync ||
          inputClock?.state.mode === "recovery",
      ),
      sequence: input?.sequence ?? 0,
      unsent: input?.pending ?? 0,
      sendThroughSequence:
        welcome && snapshot ? inputSequenceLimit(welcome.initialServerTick, snapshot.tick) : 0,
      held: input?.held ?? 0,
      pendingEdges: input?.pendingEdges ?? 0,
      inputClock: inputClock?.state ?? null,
      snapshotTick: snapshot?.tick ?? 0,
      predictedTick: prediction?.tick ?? 0,
      pending: prediction?.pending ?? 0,
      receipts,
      actor,
      authoritative: snapshot?.players[slot] ?? null,
    };
  }
  function inspect() {
    element("status").textContent =
      `Slot ${slot + 1} · authority ${snapshot?.tick ?? 0} · predicted ${prediction?.tick ?? 0} · ${error ?? (connection ? connectionText(connection.status) : "Initializing renderer")}`;
    element("details").textContent = JSON.stringify(
      { ...status(), receipts: receipts.slice(-3) },
      null,
      2,
    );
  }
  function sendCommands(commands: InputCommand[]) {
    if (!snapshot || !welcome || error) return;
    trace("send", commands[0]?.sequence ?? 0, commands.at(-1)?.sequence ?? 0, 0);
    connection.send(
      new Uint8Array(
        encodeInputBatch({
          runEpoch: welcome.runEpoch,
          connectionEpoch: welcome.connectionEpoch,
          packetSequence: ++packet,
          snapshotAck: snapshot.snapshotId,
          eventAck: eventReceiver?.cursor ?? 0,
          commands,
        }),
      ).buffer,
    );
  }
  function capture() {
    if (!input || !prediction || inputStopped || error) return;
    // The scripted workload follows world time even when a fresh session resets command counters.
    const fixtureTick = (welcome?.initialServerTick ?? 0) + input.sequence;
    if (element<HTMLInputElement>("scripted").checked && mode === "combat") {
      input.press("script-fire", { held: Held.Fire, edge: Edge.FireOnset });
    } else if (element<HTMLInputElement>("scripted").checked) {
      const held =
        fixtureTick >= 180 && slot === 0
          ? Held.Down
          : fixtureTick < 10
            ? Held.Right
            : fixtureTick >= 30 && fixtureTick < 40
              ? Held.Left
              : fixtureTick >= 70 && fixtureTick < 80
                ? Held.Down
                : 0;
      for (const bit of [Held.Left, Held.Right, Held.Down]) {
        const source = `script-${bit}`;
        if (held & bit) input.press(source, { held: bit });
        else input.release(source);
      }
      if (fixtureTick === 6 + slot * 3 || fixtureTick === 160 + slot * 3) {
        input.press("script-jump", { edge: Edge.Jump });
        input.release("script-jump");
      }
    }
    if (!element<HTMLInputElement>("scripted").checked) {
      for (const source of [
        "script-fire",
        "script-jump",
        ...[Held.Left, Held.Right, Held.Down].map((bit) => `script-${bit}`),
      ])
        input.release(source);
    }
    const actor = prediction.actor;
    const command = input.capture(
      directionalIntent(input.held, actor.facing, actor.body.grounded).aim,
    );
    prediction.submit(command);
    trace("capture", command.sequence, command.sequence, prediction.tick);
  }
  function flush(force = false) {
    if (!welcome || !snapshot || error) return false;
    const commands = input?.takeBatch(
      performance.now(),
      inputSequenceLimit(welcome.initialServerTick, snapshot.tick),
      force,
    );
    if (commands) sendCommands(commands);
    return Boolean(commands);
  }
  function startCaptureClock() {
    if (inputClock || !input || inputStopped) return;
    inputClock = new RoomClock({
      initialTick: input.sequence,
      port: {
        now: () => performance.now(),
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      step: () => {
        capture();
        flush();
      },
      onDiscontinuity: (fault) => {
        lastFailure = `Client input clock: ${fault.reason}`;
        if (automatic) connection.retry();
        else fail(lastFailure);
      },
    });
    inputClock.start();
  }
  function prepareInput() {
    if (snapshot?.roomMode !== "loading" && snapshot?.roomMode !== "playing")
      throw new Error("Load the room before preparing gameplay input");
    if (prepared) throw new Error("Already prepared");
    prepared = true;
    for (let i = 0; i < CONTROLLER_INPUT_PREFILL_TICKS; i++) {
      capture();
      if (i % 3 === 2 || i === CONTROLLER_INPUT_PREFILL_TICKS - 1) flush(true);
    }
  }
  element("prepare").onclick = () => {
    try {
      prepareInput();
      inspect();
    } catch (e) {
      error ??= String(e);
      inspect();
    }
  };
  function receiveSocket(data: unknown, generation: number) {
    try {
      if (typeof data === "string") {
        if (!welcome) {
          welcome = decodeHandshake(data, identity);
          if (
            welcome.capabilities !==
            (mode === "combat"
              ? INPUT_MAPPING_CAPABILITY | EVENT_CAPABILITY
              : INPUT_MAPPING_CAPABILITY)
          )
            throw new Error("Required input/event capabilities missing");
        } else {
          if (pendingMapping) throw new Error("Unpaired input mapping");
          if (mode === "combat" && JSON.parse(data).type === "resync-required") {
            if (pendingEventBaseline) throw new Error("Unpaired event baseline");
            pendingEventBaseline = decodeEventBaseline(data, welcome);
            return;
          }
          pendingMapping = decodeInputMapping(data);
          trace(
            "mapping",
            pendingMapping.nextSequence,
            pendingMapping.nextSequence,
            pendingMapping.nextCommandTick,
          );
        }
        return;
      }
      if (!welcome || !(data instanceof ArrayBuffer))
        throw new Error("Missing welcome/binary data");
      const context = {
        ...probeContext(slot),
        ...(mode === "combat" ? { shapeIds: COMBAT_SHAPE_IDS } : {}),
        runEpoch: welcome.runEpoch,
        connectionEpoch: welcome.connectionEpoch,
        playerId: welcome.playerId,
      };
      if (new Uint8Array(data)[4] === EVENT_TYPE) {
        if (mode !== "combat" || !eventReceiver || pendingMapping || pendingEventBaseline)
          throw new Error("Unexpected gameplay event frame");
        let batch = decodeEventBatch(new Uint8Array(data), combatEventContext(context));
        if (eventFaults.dropNext > 0 || eventFaults.pauseUntilBaseline) {
          eventFaults.dropNext = Math.max(0, eventFaults.dropNext - 1);
          eventFramesDropped++;
          return;
        }
        try {
          // Application-consumer fault, distinct from dropping an intact wire frame.
          if (eventFaults.gapNext) {
            const nextCursor = eventReceiver.cursor + 1;
            const fresh = batch.events.filter((item) => item.cursor >= nextCursor);
            if (fresh.length > 1 && fresh[0]?.cursor === nextCursor) {
              // Dropping a replayed duplicate does not create a gap. Omit the next unconsumed
              // event and retain a later event so the consumer must request its baseline.
              batch = { ...batch, events: fresh.slice(1) };
              eventFaults.gapNext = false;
              eventGapsInjected++;
            }
          }
          const accepted = eventReceiver.consume(batch);
          if (eventFaults.duplicate) accepted.push(...eventReceiver.consume(batch));
          for (const item of accepted) {
            eventHash = stateHash([eventHash, { runEpoch: welcome.runEpoch, ...item }]);
            eventCounts[item.event.kind] = (eventCounts[item.event.kind] ?? 0) + 1;
            eventReceipts.push({
              cursor: item.cursor,
              tick: item.tick,
              counter: item.counter,
              kind: item.event.kind,
              origin: item.event.origin,
              ownerId: item.event.ownerId,
              confirmation: item.event.confirmation,
              hash: eventHash,
            });
            confirmedEffects.push(item);
          }
          if (eventReceipts.length > 512) eventReceipts.splice(0, eventReceipts.length - 512);
          if (confirmedEffects.length > 512)
            confirmedEffects.splice(0, confirmedEffects.length - 512);
        } catch (failure) {
          if (!(failure instanceof ProtocolError) || failure.code !== "resync-required")
            throw failure;
          if (!eventRepairRequested) {
            connection.send(
              JSON.stringify({
                type: "event-resync-request",
                runEpoch: welcome.runEpoch,
                connectionEpoch: welcome.connectionEpoch,
                lastEventCursor: eventReceiver.cursor,
              }),
            );
            eventRepairRequested = true;
          }
        }
        return;
      }
      const initial = snapshot === null;
      const incoming = snapshot
        ? decodeSnapshot(new Uint8Array(data), context)
        : decodeInitialSnapshot(new Uint8Array(data), welcome, context);
      if (incoming.stateHash !== roomWorkloadHash(incoming))
        throw new Error("World digest mismatch");
      if (snapshot && (incoming.tick < snapshot.tick || incoming.snapshotId <= snapshot.snapshotId))
        throw new Error("Snapshot regression");
      const actor = incoming.players[slot],
        acknowledgment = incoming.acknowledgments[slot];
      if (!actor || !acknowledgment) throw new Error("Missing local controller");
      if (initial) {
        initialActor = structuredClone(actor);
        if (connectionHistory.length >= 32) throw new Error("Connection history limit");
        connectionHistory.push({
          generation,
          runEpoch: incoming.runEpoch,
          connectionEpoch: incoming.connectionEpoch,
          baselineTick: incoming.tick,
          previousTick: lastObservedTick,
          rewindTicks: Math.max(0, lastObservedTick - incoming.tick),
        });
      }
      trace(
        "snapshot",
        acknowledgment.lastProcessedSequence,
        acknowledgment.lastProcessedSequence,
        incoming.tick,
      );
      const baseline = {
        snapshotId: incoming.snapshotId,
        runEpoch: incoming.runEpoch,
        connectionEpoch: incoming.connectionEpoch,
        tick: incoming.tick,
        actor,
        acknowledgment,
      };
      const mapping = pendingMapping;
      pendingMapping = null;
      if (!mapping) throw new Error("Snapshot missing its input mapping");
      const correction = prediction ? prediction.reconcile(baseline, mapping).correction : null;
      if (input && actor.controlEpoch > input.controlEpoch)
        input.advanceControlEpoch(actor.controlEpoch);
      prediction ??= new ControllerPrediction(
        baseline,
        (a, c, t) =>
          mode === "combat"
            ? predictCombatMovement(a, c, t, snapshot?.platforms.length ? "ordnance" : "range")
            : stepNetworkController(a, c, t).actor,
        mapping,
      );
      input ??= new InputCapture(actor.controlEpoch);
      snapshot = incoming;
      lastObservedTick = incoming.tick;
      if (mode === "combat") {
        eventReceiver ??= new EventReceiver(combatEventContext(context), incoming);
        if (pendingEventBaseline) {
          eventReceiver.installBaseline(incoming, pendingEventBaseline);
          pendingEventBaseline = null;
          eventRepairRequested = false;
          eventFaults.pauseUntilBaseline = false;
          confirmedEffects.length = 0;
          // Explicit acceptance couples this full snapshot to its replacement event prefix.
          sendCommands([]);
        }
      }
      if (receipts.length >= 500) throw new Error("Receipt history bound");
      receipts.push({
        continuationHash: mode === "combat" ? combatContinuationHash(incoming) : null,
        enemies: incoming.enemies.length,
        projectiles: incoming.projectiles.length,
        volumes: incoming.combat?.volumes.length ?? 0,
        vehicles: structuredClone(incoming.vehicles),
        platforms: structuredClone(incoming.platforms),
        shots: actor.weapon.shotOrdinal,
        tick: incoming.tick,
        hash: incoming.stateHash,
        bytes: data.byteLength,
        y: actor.body.y,
        shape: actor.body.shapeId,
        ack: acknowledgment.lastProcessedSequence,
        correctionX: correction?.x ?? 0,
        correctionY: correction?.y ?? 0,
        correctionChanged: correction?.changed ?? false,
      });
      if (initial && !connection.ready(generation)) return;
      if (initial && mode === "combat" && incoming.roomMode === "playing") prepareInput();
      if (prepared && incoming.roomMode === "playing") {
        // Snapshot receipt releases transport credit; capture keeps its independent 60 Hz clock.
        const sent = flush(inputStopped);
        if (inputStopped) {
          if (!sent) sendCommands([]);
        } else startCaptureClock();
      } else if (["lobby", "intermission", "completed"].includes(incoming.roomMode)) {
        inputClock?.stop();
        input?.neutralize();
        sendCommands([]);
      } else if (incoming.roomMode === "loading") {
        if (initial) sendCommands([]);
      } else {
        fail("Room lifecycle requires a fresh input baseline");
      }
      inspect();
    } catch (e) {
      fail(e);
    }
  }
  function resetSession() {
    inputClock?.close();
    inputClock = null;
    input?.neutralize();
    input = null;
    welcome = null;
    snapshot = null;
    prediction = null;
    initialActor = null;
    pendingMapping = null;
    eventReceiver = null;
    pendingEventBaseline = null;
    eventRepairRequested = false;
    eventHash = "0";
    eventReceipts.length = 0;
    confirmedEffects.length = 0;
    for (const key of Object.keys(eventCounts)) delete eventCounts[key];
    receipts.length = 0;
    packet = 0;
    prepared = false;
    error = null;
    lastFailure = "";
    inputStopped = false;
  }
  let rendered = () => {};
  const rendererReady = new Promise<void>((resolve) => {
    rendered = resolve;
  });
  class NetworkScene extends Phaser.Scene {
    private graphics?: Phaser.GameObjects.Graphics;
    create() {
      this.graphics = this.add.graphics();
      this.game.events.once(Phaser.Core.Events.POST_RENDER, rendered);
    }
    update() {
      const g = this.graphics;
      if (!g) return;
      g.clear();
      g.fillStyle(0x526075);
      for (const t of terrain)
        g.fillRect(t.rect.x / 256, t.rect.y / 256, t.rect.w / 256, t.rect.h / 256);
      for (const platform of snapshot?.platforms ?? []) {
        const shape = COMBAT_SHAPES.get(platform.shapeId);
        if (!shape) throw new Error("Missing platform shape");
        const rect = worldRect(platform, shape.rect, 1);
        g.fillRect(rect.x / 256, rect.y / 256, rect.w / 256, rect.h / 256);
      }
      for (const actor of snapshot?.players ?? []) {
        const shape = FOOT_SHAPES.get(actor.body.shapeId);
        if (!shape) continue;
        const r = worldRect(actor.body, shape.rect, actor.facing);
        g.lineStyle(1, actor.slot === slot ? 0xff986c : 0xa5b38d);
        g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
        if (
          mode === "combat" &&
          actor.life === "alive" &&
          actor.vehicleId === null &&
          actor.weapon.id === "heavy-machine-gun" &&
          (actor.action.kind === "ready" || actor.action.kind === "fire")
        ) {
          const pose = actionPose(COMBAT_CATALOG, firearmPoseTimeline(actor, COMBAT_CATALOG), 0);
          const muzzle = pose?.sockets.find((socket) => socket.name === "muzzle");
          const hand = pose?.sockets.find((socket) => socket.name === "hand");
          if (muzzle && hand) {
            const a = worldSocket(actor.body, hand.point, actor.facing),
              b = worldSocket(actor.body, muzzle.point, actor.facing);
            g.lineStyle(2, 0xff80db);
            g.lineBetween(a.x / 256, a.y / 256, b.x / 256, b.y / 256);
          }
        }
      }
      if (mode === "combat") {
        for (const tank of snapshot?.vehicles ?? []) drawTankOverlay(g, tank, snapshot?.tick ?? 0);
        for (const enemy of snapshot?.enemies ?? []) {
          const shape = FOOT_SHAPES.get(enemy.shapeId);
          if (!shape) continue;
          const r = worldRect(enemy, shape.rect, enemy.facing);
          g.lineStyle(1, enemy.mode === 1 ? 0xffce60 : enemy.mode === 3 ? 0x9d91a9 : 0xff677d);
          g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
          if (enemy.definitionId === 4) {
            const pose = shieldPresentation(enemy.mode, enemy.modeTicks, SHIELD_PROFILE);
            g.lineStyle(
              2,
              pose.phase === "stunned" ? 0xbba4ff : pose.phase === "turn" ? 0xffce60 : 0xffae43,
            );
            if (pose.raised) {
              const shield = COMBAT_SHAPES.get(8);
              if (shield) {
                const guard = worldRect(enemy, shield.rect, enemy.facing);
                g.strokeRect(guard.x / 256, guard.y / 256, guard.w / 256, guard.h / 256);
              }
            } else {
              g.lineBetween(
                enemy.x / 256 - 7,
                enemy.y / 256 - 36,
                enemy.x / 256 + 7,
                enemy.y / 256 - 36,
              );
              if (pose.broken)
                g.lineBetween(
                  enemy.x / 256 - 4,
                  enemy.y / 256 - 39,
                  enemy.x / 256 + 4,
                  enemy.y / 256 - 33,
                );
            }
          }
        }
        for (const threat of snapshot?.threats ?? []) {
          g.lineStyle(1, (snapshot?.tick ?? 0) < threat.activeTick ? 0xffce60 : 0xff677d);
          const blade = [9, 12].includes(threat.shapeId) && COMBAT_SHAPES.get(threat.shapeId);
          if (blade) {
            const r = worldRect(threat, blade.rect, threat.heading === 3 ? -1 : 1);
            g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
            continue;
          }
          g.strokeCircle(threat.x / 256, threat.y / 256, 3);
          g.lineBetween(
            threat.x / 256,
            threat.y / 256,
            threat.x / 256 + Math.sign(threat.vx) * 30,
            threat.y / 256 + Math.sign(threat.vy) * 30,
          );
        }
        for (const exposure of snapshot?.combat?.volumes ?? []) {
          const r = exposure.rect,
            color =
              exposure.definitionId === 10 ? 0xffe475 : exposure.attached ? 0xff9647 : 0xff5b45;
          g.fillStyle(color, 0.3);
          g.fillRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
          g.lineStyle(1, color);
          g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
        }
        for (const projectile of snapshot?.projectiles ?? []) {
          if (projectile.definitionId === 5) {
            g.fillStyle(0xa4e488);
            g.fillCircle(projectile.x / 256, projectile.y / 256, 3);
            if ((snapshot?.tick ?? 0) - projectile.spawnTick >= projectile.lifetimeTicks - 15) {
              g.lineStyle(1, 0xff677d);
              g.strokeCircle(projectile.x / 256, projectile.y / 256, 5);
            }
            continue;
          }
          g.fillStyle(projectile.definitionId === 3 ? 0xff677d : 0xffe475);
          g.fillRect(projectile.x / 256 - 1, projectile.y / 256 - 1, 3, 2);
        }
        for (const item of confirmedEffects) {
          const age = (snapshot?.tick ?? 0) - item.tick;
          if (
            age < 0 ||
            age > 8 ||
            item.event.kind === "sound" ||
            item.event.kind === "action-sound"
          )
            continue;
          g.lineStyle(
            1,
            item.event.kind === "explosion"
              ? 0xa4e488
              : item.event.kind === "killed"
                ? 0xff677d
                : 0xffe475,
          );
          g.strokeCircle(
            item.event.x / 256,
            item.event.y / 256,
            item.event.kind === "explosion"
              ? GRENADE_PROFILE.radius / 256
              : item.event.kind === "killed"
                ? 7
                : 3,
          );
        }
      }
      const actor = prediction?.actor,
        shape = actor && FOOT_SHAPES.get(actor.body.shapeId);
      if (actor && shape) {
        const r = worldRect(actor.body, shape.rect, actor.facing);
        g.lineStyle(1, 0x6bd8ec);
        g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
      }
    }
  }
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: 640,
    height: 360,
    pixelArt: true,
    antialias: false,
    scene: NetworkScene,
    audio: { noAudio: true },
  });
  // GPU startup must finish before requesting a baseline from an already moving world.
  await rendererReady;
  connection = new RoomSocketConnection({
    port: browserConnectionPort(),
    automatic,
    prepare: async (signal) => {
      if (mode === "combat") {
        if (!profileReady) {
          const response = await fetch(`${base.origin}/profile`, {
            method: "POST",
            credentials: "include",
            signal,
          });
          if (!response.ok) throw new RoomConnectError("outage");
          if (signal.aborted) throw new Error("Retired profile request");
          profileReady = true;
        }
        const response = await fetch(`${base.origin}/combat/admission?slot=${slot}`, {
          credentials: "include",
          signal,
        });
        await requireRoomAdmission(response, identity);
      }
      if (signal.aborted) throw new Error("Retired admission request");
      resetSession();
      return `${base.origin.replace("http:", "ws:")}/${mode}/connect?slot=${slot}`;
    },
    opened: () => {},
    message: receiveSocket,
    suspended: () => {
      inputClock?.close();
      neutral();
    },
    status: (state) => {
      if (connectionStates.length < 128)
        connectionStates.push({
          phase: state.phase,
          generation: state.generation,
          attempt: state.attempt,
          reason: state.reason,
          atMs: performance.now(),
          detail: lastFailure.slice(0, 256),
        });
      if (state.phase === "stopped")
        error ??= automatic ? connectionText(state) : lastFailure || connectionText(state);
      element("reconnect").hidden = state.phase !== "stopped";
      inspect();
    },
    classifyClose: (code, reason) => {
      lastFailure = `closed: ${code} ${reason}`;
      if (reason === "connection-replaced") return "replaced";
      if (["observer-closed", "wall-limit", "tick-limit"].includes(reason)) return "room-ended";
      if (reason === "invalid-input") return "protocol-error";
      return "outage";
    },
  });
  element("reconnect").onclick = () => {
    if (!automatic || connection.status.reason === "incompatible-build") location.reload();
    else connection.start();
  };
  connection.start();
  const hostCommand = async (command: HostAction, observed?: HostCommand) => {
    if (!welcome || mode !== "combat") throw new Error("Combat session required");
    const session = await readRoomControlState(
      await fetch(`${base.origin}/combat/session`, { credentials: "include" }),
    );
    const body: HostCommand = observed ?? {
      command,
      runEpoch: welcome.runEpoch,
      connectionEpoch: welcome.connectionEpoch,
      membershipEpoch: session.membershipEpoch,
    };
    const response = await fetch(`${base.origin}/combat/control`, {
      method: "POST",
      credentials: "include",
      body: JSON.stringify(body),
    });
    return { status: response.status };
  };
  for (const command of ["load", "start", "continue"] as const) {
    const button = element(`host-${command}`);
    button.hidden = mode !== "combat";
    button.onclick = () => {
      void hostCommand(command)
        .then((response) => {
          if (response.status !== 200) throw new Error(`${command}: ${response.status}`);
          inspect();
        })
        .catch((failure) => {
          element("status").textContent = String(failure);
        });
    };
  }
  Object.assign(window, {
    controllerNetworkLab: {
      status,
      hostCommand,
      pauseConnection: () => connection.leave(),
      resumeConnection: () => connection.start(),
      configureEvents: (faults: Partial<typeof eventFaults>) => {
        if (mode !== "combat") throw new Error("Combat event lab required");
        Object.assign(eventFaults, faults);
      },
      stopInput: () => {
        // Stop new capture; retained commands drain within authority's window on later snapshots.
        inputStopped = true;
        inputClock?.stop();
        neutral();
        flush(true);
      },
    },
  });
}
void startLab().catch((error) => {
  const status = document.getElementById("status");
  if (status) status.textContent = `Startup failed: ${error}`;
  throw error;
});
