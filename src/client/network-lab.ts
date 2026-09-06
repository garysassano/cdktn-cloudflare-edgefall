import Phaser from "phaser";
import { Edge, Held, type InputCommand } from "../game/input/types.js";
import { FOOT_SHAPES } from "../game/labs/foot-fixture.js";
import { worldRect } from "../game/physics/body.js";
import {
  CONTROLLER_IDENTITY,
  CONTROLLER_TERRAIN,
  stepNetworkController,
} from "../shared/diagnostics/controller-workload.js";
import { probeContext, roomWorkloadHash } from "../shared/diagnostics/room-workload.js";
import { ControllerPrediction } from "../shared/prediction/controller.js";
import { encodeInputBatch } from "../shared/protocol/codec.js";
import { type Handshake, decodeHandshake } from "../shared/protocol/handshake.js";
import { decodeSnapshot } from "../shared/protocol/snapshot.js";
import type { FullSnapshot } from "../shared/protocol/snapshot-schema.js";

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
let sequence = 0,
  packet = 0,
  jumpId = 0,
  prepared = false,
  jump = false,
  error: string | null = null;
const keys = new Set<string>();
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
const bindings: Record<string, number> = {
  ArrowLeft: Held.Left,
  KeyA: Held.Left,
  ArrowRight: Held.Right,
  KeyD: Held.Right,
  ArrowUp: Held.Up,
  KeyW: Held.Up,
  ArrowDown: Held.Down,
  KeyS: Held.Down,
};
const surface = element("game");
surface.addEventListener("keydown", (event) => {
  const e = event as KeyboardEvent;
  if (bindings[e.code] || e.code === "Space") {
    e.preventDefault();
    keys.add(e.code);
  }
  if (e.code === "Space" && !e.repeat) jump = true;
});
surface.addEventListener("keyup", (event) => keys.delete((event as KeyboardEvent).code));
function neutral() {
  keys.clear();
  jump = false;
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
    requiresResync: prediction?.requiresResync ?? false,
    sequence,
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
function send() {
  if (!prediction || !snapshot || !welcome || error) return;
  if (inputStopped) {
    socket.send(
      new Uint8Array(
        encodeInputBatch({
          runEpoch: welcome.runEpoch,
          connectionEpoch: welcome.connectionEpoch,
          packetSequence: ++packet,
          snapshotAck: snapshot.snapshotId,
          eventAck: 0,
          commands: [],
        }),
      ).buffer,
    );
    return;
  }
  const commands: InputCommand[] = [];
  for (let i = 0; i < 3; i++) {
    const clientTick = sequence;
    const scripted = element<HTMLInputElement>("scripted").checked;
    const held = scripted
      ? clientTick >= 180 && slot === 0
        ? Held.Down
        : clientTick < 10
          ? Held.Right
          : clientTick >= 30 && clientTick < 40
            ? Held.Left
            : clientTick >= 70 && clientTick < 80
              ? Held.Down
              : 0
      : [...keys].reduce((h, key) => h | (bindings[key] ?? 0), 0);
    const requested = scripted
      ? clientTick === 6 + slot * 3 || clientTick === 160 + slot * 3
      : jump;
    const command: InputCommand = {
      sequence: ++sequence,
      clientTick,
      controlEpoch: welcome ? prediction.actor.controlEpoch : 1,
      held,
      aim: 0,
      edges: requested ? [{ kind: Edge.Jump, id: ++jumpId }] : [],
    };
    jump = false;
    prediction.submit(command);
    commands.push(command);
  }
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
element("prepare").onclick = () => {
  try {
    if (prepared) throw new Error("Already prepared");
    prepared = true;
    send();
    send();
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
    if (snapshot && (incoming.tick <= snapshot.tick || incoming.snapshotId <= snapshot.snapshotId))
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
    if (prepared && incoming.roomMode === "playing") send();
    inspect();
  } catch (e) {
    error ??= String(e);
    neutral();
    inspect();
  }
});
socket.addEventListener("close", (event) => {
  if (event.reason !== "observer-closed") error ??= `closed: ${event.code} ${event.reason}`;
  inspect();
});
socket.addEventListener("error", () => {
  error ??= "WebSocket failure";
  inspect();
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
      inputStopped = true;
      neutral();
    },
  },
});
