import Phaser from "phaser";
import { stateHash } from "../game/core/canonical.js";
import { Edge, Held, type InputCommand, directionalIntent } from "../game/input/types.js";
import { FOOT_SHAPES } from "../game/labs/foot-fixture.js";
import { worldRect } from "../game/physics/body.js";
import { combatEventContext } from "../shared/diagnostics/combat-events.js";
import {
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
import { type InputBinding, InputCapture } from "../shared/input/capture.js";
import { ControllerPrediction } from "../shared/prediction/controller.js";
import { decodeInitialSnapshot } from "../shared/protocol/baseline.js";
import { encodeInputBatch } from "../shared/protocol/codec.js";
import { EventReceiver } from "../shared/protocol/event-stream.js";
import {
  EVENT_CAPABILITY,
  EVENT_TYPE,
  type EventBaseline,
  type EventEnvelope,
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
        "Engineering graphics. Four browsers share one authoritative combat world. Cyan predicts local movement; enemies, projectiles and ammo use committed snapshots. Confirmed hit/shot markers use acknowledged, deduplicated events. Predicted effects, final audio and remote interpolation remain in progress.";
    const controls = document.getElementById("controls");
    if (controls)
      controls.textContent =
        "Arrows/WASD move and aim, Space jumps, Z fires. The deterministic fixture holds fire in all four clients. Commands are captured independently at 60 Hz and sent in bounded batches. Fire, projectiles and kill credit come from the same accepted world tick. This local diagnostic room does not implement combat recovery.";
  }
  if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error("Invalid slot");
  function element<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing ${id}`);
    return el as T;
  }
  const socket = new WebSocket(
    `${base.origin.replace("http:", "ws:")}/${mode}/connect?slot=${slot}`,
  );
  socket.binaryType = "arraybuffer";
  let welcome: Handshake | null = null,
    snapshot: FullSnapshot | null = null,
    prediction: ControllerPrediction | null = null;
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
    shots: number;
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
    error ??= String(e);
    inputClock?.stop();
    neutral();
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
      enemies: snapshot?.enemies ?? [],
      projectiles: snapshot?.projectiles ?? [],
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
      initialServerTick: welcome?.initialServerTick ?? 0,
      inputStopped,
      ready: welcome !== null && snapshot !== null,
      prepared,
      error,
      requiresResync: Boolean(
        prediction?.requiresResync ||
          input?.requiresResync ||
          inputClock?.state.mode === "recovery",
      ),
      sequence: input?.sequence ?? 0,
      unsent: input?.pending ?? 0,
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
      `Slot ${slot + 1} · authority ${snapshot?.tick ?? 0} · predicted ${prediction?.tick ?? 0} · ${error ?? "connected"}`;
    element("details").textContent = JSON.stringify(
      { ...status(), receipts: receipts.slice(-3) },
      null,
      2,
    );
  }
  function sendCommands(commands: InputCommand[]) {
    if (!snapshot || !welcome || error) return;
    if (socket.bufferedAmount > 4096) throw new Error("Outbound queue requires resync");
    trace("send", commands[0]?.sequence ?? 0, commands.at(-1)?.sequence ?? 0, 0);
    socket.send(
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
    const commands = input?.takeBatch(performance.now(), force);
    if (commands) sendCommands(commands);
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
      onDiscontinuity: (fault) => fail(`Client input clock: ${fault.reason}`),
    });
    inputClock.start();
  }
  element("prepare").onclick = () => {
    try {
      if (prepared) throw new Error("Already prepared");
      prepared = true;
      for (let i = 0; i < CONTROLLER_INPUT_PREFILL_TICKS; i++) {
        capture();
        if (i % 3 === 2 || i === CONTROLLER_INPUT_PREFILL_TICKS - 1) flush(true);
      }
      inspect();
    } catch (e) {
      error ??= String(e);
      inspect();
    }
  };
  socket.addEventListener("message", (event) => {
    try {
      if (typeof event.data === "string") {
        if (!welcome) {
          welcome = decodeHandshake(event.data, identity);
          if (
            welcome.capabilities !==
            (mode === "combat"
              ? INPUT_MAPPING_CAPABILITY | EVENT_CAPABILITY
              : INPUT_MAPPING_CAPABILITY)
          )
            throw new Error("Required input/event capabilities missing");
        } else {
          if (pendingMapping) throw new Error("Unpaired input mapping");
          if (mode === "combat" && JSON.parse(event.data).type === "resync-required") {
            if (pendingEventBaseline) throw new Error("Unpaired event baseline");
            pendingEventBaseline = decodeEventBaseline(event.data, welcome);
            return;
          }
          pendingMapping = decodeInputMapping(event.data);
          trace(
            "mapping",
            pendingMapping.nextSequence,
            pendingMapping.nextSequence,
            pendingMapping.nextCommandTick,
          );
        }
        return;
      }
      if (!welcome || !(event.data instanceof ArrayBuffer))
        throw new Error("Missing welcome/binary data");
      const context = {
        ...probeContext(slot),
        runEpoch: welcome.runEpoch,
        connectionEpoch: welcome.connectionEpoch,
        playerId: welcome.playerId,
      };
      if (new Uint8Array(event.data)[4] === EVENT_TYPE) {
        if (mode !== "combat" || !eventReceiver || pendingMapping || pendingEventBaseline)
          throw new Error("Unexpected gameplay event frame");
        let batch = decodeEventBatch(new Uint8Array(event.data), combatEventContext(context));
        if (eventFaults.dropNext > 0 || eventFaults.pauseUntilBaseline) {
          eventFaults.dropNext = Math.max(0, eventFaults.dropNext - 1);
          eventFramesDropped++;
          return;
        }
        try {
          // Application-consumer fault, distinct from dropping an intact wire frame.
          if (eventFaults.gapNext && batch.events.length > 1) {
            batch = { ...batch, events: batch.events.slice(1) };
            eventFaults.gapNext = false;
            eventGapsInjected++;
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
            socket.send(
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
      const incoming = snapshot
        ? decodeSnapshot(new Uint8Array(event.data), context)
        : decodeInitialSnapshot(new Uint8Array(event.data), welcome, context);
      if (incoming.stateHash !== roomWorkloadHash(incoming))
        throw new Error("World digest mismatch");
      if (snapshot && (incoming.tick < snapshot.tick || incoming.snapshotId <= snapshot.snapshotId))
        throw new Error("Snapshot regression");
      const actor = incoming.players[slot],
        acknowledgment = incoming.acknowledgments[slot];
      if (!actor || !acknowledgment) throw new Error("Missing local controller");
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
      prediction ??= new ControllerPrediction(
        baseline,
        (a, c, t) =>
          mode === "combat" ? predictCombatMovement(a, c, t) : stepNetworkController(a, c, t).actor,
        mapping,
      );
      input ??= new InputCapture(actor.controlEpoch);
      snapshot = incoming;
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
        enemies: incoming.enemies.length,
        projectiles: incoming.projectiles.length,
        shots: actor.weapon.shotOrdinal,
        tick: incoming.tick,
        hash: incoming.stateHash,
        bytes: event.data.byteLength,
        y: actor.body.y,
        shape: actor.body.shapeId,
        ack: acknowledgment.lastProcessedSequence,
        correctionX: correction?.x ?? 0,
        correctionY: correction?.y ?? 0,
        correctionChanged: correction?.changed ?? false,
      });
      if (prepared && incoming.roomMode === "playing") {
        if (inputStopped) sendCommands([]);
        else startCaptureClock();
      } else if (incoming.roomMode !== "loading") {
        fail("Room lifecycle requires a fresh input baseline");
      }
      inspect();
    } catch (e) {
      fail(e);
    }
  });
  socket.addEventListener("close", (event) => {
    element("reconnect").hidden = mode === "combat";
    inputClock?.close();
    neutral();
    if (event.reason !== "observer-closed") error ??= `closed: ${event.code} ${event.reason}`;
    inspect();
  });
  element("reconnect").onclick = () => location.reload();
  socket.addEventListener("error", () => {
    fail("WebSocket failure");
  });
  class NetworkScene extends Phaser.Scene {
    private graphics?: Phaser.GameObjects.Graphics;
    create() {
      this.graphics = this.add.graphics();
    }
    update() {
      const g = this.graphics;
      if (!g) return;
      g.clear();
      g.fillStyle(0x526075);
      for (const t of terrain)
        g.fillRect(t.rect.x / 256, t.rect.y / 256, t.rect.w / 256, t.rect.h / 256);
      for (const actor of snapshot?.players ?? []) {
        const shape = FOOT_SHAPES.get(actor.body.shapeId);
        if (!shape) continue;
        const r = worldRect(actor.body, shape.rect, actor.facing);
        g.lineStyle(1, actor.slot === slot ? 0xff986c : 0xa5b38d);
        g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
      }
      if (mode === "combat") {
        for (const enemy of snapshot?.enemies ?? []) {
          const shape = FOOT_SHAPES.get(enemy.shapeId);
          if (!shape) continue;
          const r = worldRect(enemy, shape.rect, enemy.facing);
          g.lineStyle(1, 0xff677d);
          g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
        }
        g.fillStyle(0xffe475);
        for (const projectile of snapshot?.projectiles ?? [])
          g.fillRect(projectile.x / 256 - 1, projectile.y / 256 - 1, 3, 2);
        for (const item of confirmedEffects) {
          const age = (snapshot?.tick ?? 0) - item.tick;
          if (age < 0 || age > 8 || item.event.kind === "sound") continue;
          g.lineStyle(1, item.event.kind === "killed" ? 0xff677d : 0xffe475);
          g.strokeCircle(
            item.event.x / 256,
            item.event.y / 256,
            item.event.kind === "killed" ? 7 : 3,
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
  Object.assign(window, {
    controllerNetworkLab: {
      status,
      configureEvents: (faults: Partial<typeof eventFaults>) => {
        if (mode !== "combat") throw new Error("Combat event lab required");
        Object.assign(eventFaults, faults);
      },
      stopInput: () => {
        // Send already captured commands before suspending to preserve sequence identity.
        flush(true);
        if (input?.pending) throw new Error("Input stop could not flush captured commands");
        inputStopped = true;
        inputClock?.stop();
        neutral();
      },
    },
  });
}
void startLab().catch((error) => {
  const status = document.getElementById("status");
  if (status) status.textContent = `Startup failed: ${error}`;
  throw error;
});
