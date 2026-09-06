import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { Edge, Held, type InputCommand } from "../src/game/input/types.js";
import type { RoomProbeStatus } from "../src/shared/diagnostics/room-probe-types.js";
import {
  PROBE_IDENTITY,
  probeContext,
  roomWorkloadHash,
} from "../src/shared/diagnostics/room-workload.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import { decodeHandshake } from "../src/shared/protocol/handshake.js";
import { decodeSnapshot } from "../src/shared/protocol/snapshot.js";
import { withDirectRoomWorker, withLocalWorker } from "./lib/local-worker.js";

assert(
  process.argv.length === 2 ||
    (process.argv.length === 3 && process.argv[2] === "--direct-workerd"),
  "This bounded local probe accepts no remote target or unbounded duration",
);
const runtimeMode = process.argv[2] === "--direct-workerd" ? "direct-workerd" : "wrangler";
type Receipt = [number, number, number, number, number, number];
interface Client {
  socket: WebSocket;
  slot: number;
  packet: number;
  sequence: number;
  snapshotAck: number;
  edgeSent: boolean;
  edgesAcknowledged: boolean;
  welcome: boolean;
  lastAckSendMs: number;
  closeCode: number | null;
  closeReason: string | null;
  receipts: Receipt[];
}
function percentile(values: number[], fraction: number): number {
  assert(values.length > 0, "Missing metric samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

async function runWorkload(base: string, assertAlive: () => void, workload: "standard" | "double") {
  const clients: Client[] = [];
  const observerClocks: Array<[number, number]> = [];
  let failure: unknown;
  let origin = performance.now();
  async function status(action = "status"): Promise<RoomProbeStatus> {
    assertAlive();
    if (failure) throw failure;
    const response = await fetch(`${base}/${workload}/${action}`, {
      method: action === "status" ? "GET" : "POST",
      signal: AbortSignal.timeout(3000),
    });
    assert(response.ok, `${workload}/${action}: HTTP ${response.status}`);
    return (await response.json()) as RoomProbeStatus;
  }
  try {
    for (let slot = 0; slot < 4; slot++) {
      const socket = new WebSocket(
        `${base.replace("http:", "ws:")}/${workload}/connect?slot=${slot}`,
      );
      socket.binaryType = "arraybuffer";
      const client: Client = {
        socket,
        slot,
        packet: 0,
        sequence: 0,
        snapshotAck: 0,
        edgeSent: false,
        edgesAcknowledged: false,
        welcome: false,
        lastAckSendMs: 0,
        closeCode: null,
        closeReason: null,
        receipts: [],
      };
      clients.push(client);
      socket.addEventListener("message", (event) => {
        try {
          if (typeof event.data === "string") {
            assert(!client.welcome, "Duplicate handshake");
            const welcome = decodeHandshake(event.data, PROBE_IDENTITY);
            assert.equal(welcome.playerId, slot + 1);
            assert.equal(welcome.initialServerTick, 0);
            client.welcome = true;
            return;
          }
          assert(
            client.welcome && event.data instanceof ArrayBuffer,
            "Snapshot without handshake or binary bytes",
          );
          const snapshot = decodeSnapshot(new Uint8Array(event.data), probeContext(slot));
          assert.equal(
            snapshot.stateHash,
            roomWorkloadHash(snapshot),
            "Decoded world digest differs",
          );
          const previous = client.receipts.at(-1);
          assert(!previous || snapshot.tick > previous[1], "Repeated/regressing snapshot tick");
          assert(snapshot.snapshotId > client.snapshotAck, "Snapshot ID regression");
          const ack = snapshot.acknowledgments[slot];
          const actor = snapshot.players[slot];
          assert(ack && actor);
          client.edgesAcknowledged ||=
            ack.processedEdgeIds[0] === 1 && ack.processedEdgeIds[4] === 1;
          assert(ack.lastProcessedSequence <= client.sequence, "Acknowledged an unsent command");
          assert(
            !previous || ack.lastProcessedSequence >= previous[4],
            "Processed acknowledgment regressed",
          );
          if (ack.lastProcessedSequence > 0) assert(ack.appliedAtServerTick > 0);
          assert(client.receipts.length < 500, "Unbounded observer history");
          client.receipts.push([
            performance.now() - origin,
            snapshot.tick,
            snapshot.snapshotId,
            event.data.byteLength,
            ack.lastProcessedSequence,
            actor.body.vx,
          ]);
          client.snapshotAck = snapshot.snapshotId;
        } catch (error) {
          failure = error;
        }
      });
      socket.addEventListener("error", () => {
        failure ??= new Error(`Client ${slot} socket error`);
      });
      socket.addEventListener("close", (event) => {
        client.closeCode = event.code;
        client.closeReason = event.reason;
      });
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure) throw failure;
      if (clients.every((client) => client.welcome && client.snapshotAck > 0)) break;
      await delay(20);
    }
    assert(
      clients.every((client) => client.welcome && client.snapshotAck > 0),
      "Four baselines not ready",
    );
    const initial = await status("start");
    const instanceId = initial.instanceId;
    origin = performance.now();
    // Baseline delivery preceded the active period; report it at t=0.
    for (const client of clients) for (const receipt of client.receipts) receipt[0] = 0;
    const phases = {
      neutralUntilMs: 2000,
      firstClientInputStopsMs: 4000,
      remainingInputStopsMs: 5000,
    };
    while (performance.now() - origin < 10_000) {
      assertAlive();
      if (failure) throw failure;
      const elapsed = performance.now() - origin;
      if (!observerClocks.length || elapsed - (observerClocks.at(-1)?.[0] ?? 0) >= 100) {
        observerClocks.push([elapsed, Date.now()]);
      }
      for (const client of clients) {
        if (client.socket.readyState !== WebSocket.OPEN) continue;
        assert(client.socket.bufferedAmount < 65536, "Client outbound queue exceeded cap");
        const commands: InputCommand[] = [];
        const inputUntil =
          client.slot === 0 ? phases.firstClientInputStopsMs : phases.remainingInputStopsMs;
        if (elapsed < inputUntil) {
          const target = Math.floor((elapsed * 60) / 1000) + 1;
          assert(target - client.sequence < 120, "Client command backlog exceeded cap");
          while (client.sequence < target && commands.length < 3) {
            const active = elapsed >= phases.neutralUntilMs;
            const edges =
              active && !client.edgeSent
                ? [
                    { kind: Edge.Jump, id: 1 },
                    { kind: Edge.FireOnset, id: 1 },
                  ]
                : [];
            client.edgeSent ||= active;
            commands.push({
              sequence: ++client.sequence,
              clientTick: client.sequence - 1,
              controlEpoch: 1,
              held: active ? (client.slot % 2 ? Held.Left : Held.Right) | Held.Fire : 0,
              aim: 0,
              edges,
            });
          }
        }
        if (!commands.length && elapsed - client.lastAckSendMs < 50) continue;
        client.lastAckSendMs = elapsed;
        client.socket.send(
          encodeInputBatch({
            runEpoch: 1,
            connectionEpoch: client.slot + 1,
            packetSequence: ++client.packet,
            snapshotAck: client.snapshotAck,
            eventAck: 0,
            commands,
          }),
        );
      }
      if (clients.every((client) => client.closeCode !== null)) break;
      await delay(8);
    }
    if (failure) throw failure;
    const final = await status();
    assert.equal(final.instanceId, instanceId, "Unexpected Durable Object reconstruction");
    assert.equal(final.clock.fault, null, "Clock failed under synthetic protocol workload");
    assert.equal(final.roomMode, "paused-empty");
    assert.equal(final.clock.mode, "stopped");
    assert.equal(final.clock.timerPending, false);
    assert.equal(final.watchdogPending, false);
    assert.equal(final.tick, final.clock.tick);
    assert(final.tick > 450 && final.tick < 550, "Unexpected short-run progression");
    assert.equal(final.peers.length, 4);
    for (const client of clients) {
      assert(client.edgesAcknowledged, "Rejected jump/fire edges were never acknowledged");
      assert.equal(client.closeCode, 4001);
      assert.equal(client.closeReason, "lease-expired");
      const peer = final.peers.find((value) => value.slot === client.slot);
      assert(peer && !peer.active);
      assert(peer.renewedFrames > 100 && peer.acknowledgmentOnlyFrames > 20);
      assert(peer.maxQueuedCommands <= 8, "Unexpected input queue growth");
      assert(peer.neutralizedAtTick !== null && peer.expiredAtTick !== null);
      assert(
        peer.expiredAtTick - peer.neutralizedAtTick > 140,
        "Lease did not outlast stale-control neutralization",
      );
      assert.equal(peer.lastHeld, 0);
      assert(
        client.receipts.some(
          (receipt) => receipt[1] >= 60 && receipt[1] <= 110 && receipt[5] === 0,
        ),
        "Fresh neutral input not observed",
      );
      assert(
        client.receipts.some(
          (receipt) => receipt[1] >= 150 && receipt[1] <= 220 && receipt[5] !== 0,
        ),
        "Active input not observed",
      );
      assert(
        client.receipts.some(
          (receipt) => receipt[1] >= (peer.neutralizedAtTick ?? 0) && receipt[5] === 0,
        ),
        "Stale input not neutralized in snapshots",
      );
    }
    await delay(300);
    const paused = await status();
    assert.equal(paused.tick, final.tick, "Empty room continued simulation");
    assert.equal(paused.clock.timerPending, false);
    assert.equal(paused.watchdogPending, false);
    assert.equal(paused.callbacks.length, final.callbacks.length);
    const bytes = clients.flatMap((client) => client.receipts.map((receipt) => receipt[3]));
    const gaps = clients.flatMap((client) =>
      client.receipts
        .slice(2)
        .map((receipt, index) => receipt[0] - (client.receipts[index + 1]?.[0] ?? 0)),
    );
    const summaries = clients.map((client) => ({
      slot: client.slot,
      frames: client.receipts.length,
      lastProcessedSequence: client.receipts.at(-1)?.[4],
      sentCommands: client.sequence,
      edgesAcknowledged: client.edgesAcknowledged,
      closeCode: client.closeCode,
      closeReason: client.closeReason,
    }));
    const snapshotP95 = percentile(bytes, 0.95);
    return {
      workload,
      lifecycleStatus: "pass",
      observerClocks,
      phases,
      final,
      metrics: {
        snapshotBytesP95: snapshotP95,
        nominalSnapshotKiBPerSecond: (snapshotP95 * 20) / 1024,
        receiptGapMsP99: percentile(gaps, 0.99),
        receiptGapsAbove100Ms: gaps.filter((value) => value > 100).length,
        receiptGapSamples: gaps.length,
        localSyntheticTickMsP99: percentile(
          final.localCpu.map((row) => row[1]),
          0.99,
        ),
        localEncodeFourClientsMsP99: percentile(
          final.localCpu.filter((row) => row[0] % 3 === 0).map((row) => row[2]),
          0.99,
        ),
      },
      payloadBudget:
        snapshotP95 < 6144 && snapshotP95 * 20 < 120 * 1024
          ? "met for synthetic fixture"
          : "not met",
      clients: summaries,
      receiptColumns: [
        "observerMs",
        "serverTick",
        "snapshotId",
        "bytes",
        "processedSequence",
        "localVelocityX",
      ],
      receipts: clients.map((client) => client.receipts),
    };
  } catch (error) {
    observerClocks.push([performance.now() - origin, Date.now()]);
    const response = await fetch(`${base}/${workload}/status`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    const probe = response?.ok ? await response.json() : null;
    await mkdir("dist/room-network-proof", { recursive: true });
    const path = `dist/room-network-proof/failure-${workload}-${Date.now()}.json`;
    await writeFile(
      path,
      `${JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          sourceSha256,
          workload,
          observerClocks,
          runtimeMode,
          wrangler: require("wrangler/package.json").version,
          workerd: workerRequire("workerd/package.json").version,
          observerClockOffsetChangesMs: observerClocks.slice(1).map((row, index) => {
            const previous = observerClocks[index];
            return previous ? row[1] - previous[1] - (row[0] - previous[0]) : 0;
          }),
          error: error instanceof Error ? error.message : String(error),
          probe,
          clients: clients.map(({ slot, sequence, closeCode, closeReason, receipts }) => ({
            slot,
            sequence,
            closeCode,
            closeReason,
            receipts,
          })),
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`Failure evidence: ${path}\n`);
    throw error;
  } finally {
    for (const client of clients) client.socket.close();
    await fetch(`${base}/${workload}/close`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
}

const require = createRequire(import.meta.url);
const workerRequire = createRequire(require.resolve("wrangler/package.json"));
const bundle = await build({
  entryPoints: ["src/worker/diagnostics/room-probe.ts", "scripts/bench-room-network.ts"],
  outdir: "dist/room-network-proof/bundle",
  packages: "external",
  bundle: true,
  external: ["cloudflare:workers"],
  platform: "node",
  format: "esm",
  write: false,
  metafile: true,
});
const source = createHash("sha256");
for (const path of [
  ...Object.keys(bundle.metafile.inputs),
  "scripts/bench-room-network.ts",
  "scripts/lib/local-worker.ts",
  "e2e/room.wrangler.jsonc",
].sort()) {
  source
    .update(path)
    .update("\0")
    .update(await readFile(path))
    .update("\0");
}
const sourceSha256 = source.digest("hex");
const runCases = async (base: string, alive: () => void) => [
  await runWorkload(base, alive, "standard"),
  await runWorkload(base, alive, "double"),
];
const results =
  runtimeMode === "direct-workerd"
    ? await withDirectRoomWorker(runCases)
    : await withLocalWorker(8792, "e2e/room.wrangler.jsonc", "edgefall-room-load-probe", runCases);
const report = {
  schemaVersion: 1,
  package: "W02",
  recordedAt: new Date().toISOString(),
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceSha256,
  environment: {
    runtimeMode,
    node: process.version,
    cpu: cpus()[0]?.model,
    platform: platform(),
    release: release(),
    wrangler: require("wrangler/package.json").version,
    workerd: workerRequire("workerd/package.json").version,
    transport:
      "Four independent Node WebSockets to local workerd per workload; same host, no network impairment",
  },
  scope:
    "Synthetic protocol workload and leases only. No gameplay kernel, browser visibility, persistence/wake recovery, deployed cadence or Rust comparison. Short receipt metrics do not close the five-minute/two-hour/six-hour gates.",
  results,
};
await mkdir("dist/room-network-proof", { recursive: true });
await writeFile(
  `dist/room-network-proof/report-${runtimeMode}.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ sourceSha256: report.sourceSha256, results: results.map((result) => ({ workload: result.workload, lifecycleStatus: result.lifecycleStatus, payloadBudget: result.payloadBudget, metrics: result.metrics })), report: `dist/room-network-proof/report-${runtimeMode}.json` })}\n`,
);
