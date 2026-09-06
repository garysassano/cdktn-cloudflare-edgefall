import Phaser from "phaser";
import { Edge, Held, type InputCommand, directionalIntent } from "../game/input/types.js";
import { FOOT_SHAPES } from "../game/labs/foot-fixture.js";
import { worldRect } from "../game/physics/body.js";
import {
  CONTROLLER_IDENTITY,
  CONTROLLER_TERRAIN,
  stepNetworkController,
} from "../shared/diagnostics/controller-workload.js";
import { probeContext, roomWorkloadHash } from "../shared/diagnostics/room-workload.js";
import { type InputBinding, InputCapture } from "../shared/input/capture.js";
import { ControllerPrediction } from "../shared/prediction/controller.js";
import { encodeInputBatch } from "../shared/protocol/codec.js";
import { type Handshake, decodeHandshake } from "../shared/protocol/handshake.js";
import { decodeSnapshot } from "../shared/protocol/snapshot.js";
import type { FullSnapshot } from "../shared/protocol/snapshot-schema.js";
import { RoomClock } from "../shared/runtime/room-clock.js";

const params = new URL(location.href).searchParams,
  base = new URL(params.get("room") ?? "http://127.0.0.1:8791");
if (base.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(base.hostname))
  throw new Error("Loopback room required");
const slot = Number(params.get("slot") ?? "0");
if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error("Invalid slot");
function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing ${id}`);
  return el as T;
}
const socket = new WebSocket(
  `${base.origin.replace("http:", "ws:")}/controller/connect?slot=${slot}`,
);
socket.binaryType = "arraybuffer";
let welcome: Handshake | null = null,
  snapshot: FullSnapshot | null = null,
  prediction: ControllerPrediction | null = null;
let inputStopped = false;
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
function status() {
  const actor = prediction?.actor;
  return {
    slot,
    inputStopped,
    ready: welcome !== null && snapshot !== null,
    prepared,
    error,
    requiresResync: Boolean(
      prediction?.requiresResync || input?.requiresResync || inputClock?.state.mode === "recovery",
    ),
    sequence: input?.sequence ?? 0,
    unsent: input?.pending ?? 0,
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
  socket.send(
    new Uint8Array(
      encodeInputBatch({
        runEpoch: welcome.runEpoch,
        connectionEpoch: welcome.connectionEpoch,
        packetSequence: ++packet,
        snapshotAck: snapshot.snapshotId,
        eventAck: 0,
        commands,
      }),
    ).buffer,
  );
}
function capture() {
  if (!input || !prediction || inputStopped || error) return;
  const clientTick = input.sequence;
  if (element<HTMLInputElement>("scripted").checked) {
    const held =
      clientTick >= 180 && slot === 0
        ? Held.Down
        : clientTick < 10
          ? Held.Right
          : clientTick >= 30 && clientTick < 40
            ? Held.Left
            : clientTick >= 70 && clientTick < 80
              ? Held.Down
              : 0;
    for (const bit of [Held.Left, Held.Right, Held.Down]) {
      const source = `script-${bit}`;
      if (held & bit) input.press(source, { held: bit });
      else input.release(source);
    }
    if (clientTick === 6 + slot * 3 || clientTick === 160 + slot * 3) {
      input.press("script-jump", { edge: Edge.Jump });
      input.release("script-jump");
    }
  }
  const actor = prediction.actor;
  const command = input.capture(
    directionalIntent(input.held, actor.facing, actor.body.grounded).aim,
  );
  prediction.submit(command);
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
    for (let i = 0; i < 6; i++) {
      capture();
      if (i % 3 === 2) flush(true);
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
      if (welcome) throw new Error("Repeated welcome");
      welcome = decodeHandshake(event.data, CONTROLLER_IDENTITY);
      return;
    }
    if (!welcome || !(event.data instanceof ArrayBuffer))
      throw new Error("Missing welcome/binary data");
    const incoming = decodeSnapshot(new Uint8Array(event.data), probeContext(slot));
    if (incoming.stateHash !== roomWorkloadHash(incoming)) throw new Error("World digest mismatch");
    if (snapshot && (incoming.tick < snapshot.tick || incoming.snapshotId <= snapshot.snapshotId))
      throw new Error("Snapshot regression");
    const actor = incoming.players[slot],
      acknowledgment = incoming.acknowledgments[slot];
    if (!actor || !acknowledgment) throw new Error("Missing local controller");
    const baseline = {
      runEpoch: incoming.runEpoch,
      connectionEpoch: incoming.connectionEpoch,
      tick: incoming.tick,
      actor,
      acknowledgment,
    };
    const correction = prediction ? prediction.reconcile(baseline).correction : null;
    prediction ??= new ControllerPrediction(
      baseline,
      (a, c, t) => stepNetworkController(a, c, t).actor,
    );
    input ??= new InputCapture(actor.controlEpoch);
    snapshot = incoming;
    if (receipts.length >= 500) throw new Error("Receipt history bound");
    receipts.push({
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
  inputClock?.close();
  neutral();
  if (event.reason !== "observer-closed") error ??= `closed: ${event.code} ${event.reason}`;
  inspect();
});
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
    for (const t of CONTROLLER_TERRAIN)
      g.fillRect(t.rect.x / 256, t.rect.y / 256, t.rect.w / 256, t.rect.h / 256);
    for (const actor of snapshot?.players ?? []) {
      const shape = FOOT_SHAPES.get(actor.body.shapeId);
      if (!shape) continue;
      const r = worldRect(actor.body, shape.rect, actor.facing);
      g.lineStyle(1, actor.slot === slot ? 0xff986c : 0xa5b38d);
      g.strokeRect(r.x / 256, r.y / 256, r.w / 256, r.h / 256);
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
