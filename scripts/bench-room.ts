import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cpus, platform, release } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { ClockSample, RoomClock } from "../src/shared/runtime/room-clock.js";

interface ProbeStatus {
  instanceId: string;
  clock: RoomClock["state"];
  timerCount: number;
  watchdogPending: boolean;
  samples: ClockSample[];
}

assert(
  process.argv.length === 2,
  "This command is a bounded local lifecycle proof; no remote URL is accepted",
);
const port = 8791;
const base = `http://127.0.0.1:${port}`;
// A TCP bind checks all port occupants, including those that do not speak HTTP.
const reservation = createServer();
await new Promise<void>((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(port, "127.0.0.1", resolve);
});
await new Promise<void>((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);
const server = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--config",
    "e2e/clock.wrangler.jsonc",
  ],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let log = "";
let terminal = false;
const exited = new Promise<void>((resolve) => {
  server.once("exit", () => {
    terminal = true;
    resolve();
  });
  server.once("error", () => {
    terminal = true;
    resolve();
  });
});
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-16_384);
  });
const observations: Array<{ atMs: number; mode: string; tick: number; timers: number }> = [];
const origin = performance.now();
let instanceId = "";
async function status(action = "status"): Promise<ProbeStatus> {
  assert(!terminal, `Owned workerd process exited: ${log}`);
  const response = await fetch(`${base}/${action}`, {
    method: action === "status" ? "GET" : "POST",
    signal: AbortSignal.timeout(2000),
  });
  assert(response.ok, `Probe ${action}: HTTP ${response.status}`);
  const result = (await response.json()) as ProbeStatus;
  assert.equal(typeof result.instanceId, "string");
  if (!instanceId) instanceId = result.instanceId;
  assert.equal(result.instanceId, instanceId, "Unexpected Durable Object restart");
  assert.equal(result.clock.fault, null, "Clock discontinuity during local timer proof");
  assert(result.timerCount <= 1 && result.timerCount >= 0, "Runaway frame timers");
  assert(result.samples.length <= 2400, "Unbounded trace");
  const previous = observations.at(-1);
  assert(!previous || result.clock.tick >= previous.tick, "Tick regression");
  observations.push({
    atMs: performance.now() - origin,
    mode: result.clock.mode,
    tick: result.clock.tick,
    timers: result.timerCount,
  });
  return result;
}
async function untilPaused(): Promise<ProbeStatus> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await status();
    if (result.clock.mode === "stopped") return result;
    await delay(50);
  }
  throw new Error("Probe did not pause within five seconds");
}
function assertIdle(result: ProbeStatus, tick: number, mode = "stopped"): void {
  assert.equal(result.clock.mode, mode);
  assert.equal(result.clock.tick, tick);
  assert.equal(result.clock.timerPending, false);
  assert.equal(result.timerCount, 0);
  assert.equal(result.watchdogPending, false);
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(!terminal, `Local workerd failed to start: ${log}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      ready =
        response.ok &&
        ((await response.json()) as { fixture: string }).fixture === "edgefall-clock-probe";
    } catch {
      /* Bounded startup polling. */
    }
    if (ready) break;
    await delay(200);
  }
  assert(ready, `Local workerd did not start: ${log}`);
  assertIdle(await status(), 0);
  await status("start");
  const first = await untilPaused();
  assertIdle(first, 120);
  await delay(300);
  assertIdle(await status(), 120);
  await status("start");
  const second = await untilPaused();
  assertIdle(second, 240);
  await status("start");
  await delay(100);
  const stopped = await status("stop");
  assert(stopped.clock.tick > 240 && stopped.clock.tick < 360);
  assertIdle(stopped, stopped.clock.tick);
  await delay(300);
  assertIdle(await status(), stopped.clock.tick);
  const closed = await status("close");
  assertIdle(closed, stopped.clock.tick, "closed");
  await delay(100);
  assertIdle(await status(), stopped.clock.tick, "closed");
  const rejected = await fetch(`${base}/start`, {
    method: "POST",
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(rejected.status, 409, "Terminal probe restarted");
  assert(second.samples.every((sample) => sample.steps >= 0 && sample.steps <= 4));
  const source = createHash("sha256");
  for (const path of [
    "src/game/core/numeric.ts",
    "src/shared/runtime/room-clock.ts",
    "src/worker/diagnostics/clock-probe.ts",
    "scripts/bench-room.ts",
    "e2e/clock.wrangler.jsonc",
  ]) {
    source
      .update(path)
      .update("\0")
      .update(await readFile(path))
      .update("\0");
  }
  const report = {
    schemaVersion: 1,
    package: "W02",
    recordedAt: new Date().toISOString(),
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceSha256: source.digest("hex"),
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      runtime: "local Wrangler/workerd Durable Object",
      wrangler: createRequire(import.meta.url)("wrangler/package.json").version as string,
      workerd: createRequire(createRequire(import.meta.url).resolve("wrangler/package.json"))(
        "workerd/package.json",
      ).version as string,
    },
    status: "pass",
    observations,
    samples: closed.samples,
    scope:
      "Bounded local scheduler lifecycle only. HTTP observation; no WebSocket clients, world/encode CPU load, storage/restart recovery, remote cadence or billing proof.",
  };
  await mkdir("dist/room-clock-proof", { recursive: true });
  await writeFile("dist/room-clock-proof/report.json", `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      completedTick: closed.clock.tick,
      callbacks: closed.samples.length,
      sourceSha256: report.sourceSha256,
      report: "dist/room-clock-proof/report.json",
      scope: report.scope,
    })}\n`,
  );
} finally {
  if (!terminal && server.pid) {
    process.kill(-server.pid, "SIGTERM");
    await Promise.race([exited, delay(3000)]);
    if (!terminal) {
      process.kill(-server.pid, "SIGKILL");
      await exited;
    }
  }
}
