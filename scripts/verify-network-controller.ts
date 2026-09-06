import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { CONTROLLER_INPUT_PREFILL_TICKS } from "../src/shared/diagnostics/controller-workload.js";
import type { RoomProbeStatus } from "../src/shared/diagnostics/room-probe-types.js";
import { withDirectRoomWorker } from "./lib/local-worker.js";

interface ClientStatus {
  timeline: unknown[];
  slot: number;
  runEpoch: number;
  initialServerTick: number;
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  sequence: number;
  snapshotTick: number;
  predictedTick: number;
  pending: number;
  unsent: number;
  held: number;
  pendingEdges: number;
  inputClock: { mode: string; tick: number } | null;
  authoritative: { processedEdgeIds: number[] } | null;
  receipts: Array<{
    tick: number;
    hash: number;
    bytes: number;
    y: number;
    shape: number;
    ack: number;
    correctionX: number;
    correctionY: number;
    correctionChanged: boolean;
  }>;
}
const recoveryMode = process.argv.includes("--recovery");
const output = recoveryMode
  ? "dist/network-controller-recovery-evidence"
  : "dist/network-controller-evidence";
await mkdir(output, { recursive: true });
// Each invocation owns its results; a failed run must never leave an older pass report.
for (const name of [
  "report.json",
  "movement-report.json",
  "failure.json",
  "failed-clients.json",
  "failure.png",
  "four-player-controller.png",
  "diagnostics.json",
])
  await rm(`${output}/${name}`, { force: true });
execFileSync("node", ["scripts/build-client.mjs", "--lab"], { stdio: "pipe" });
const root = resolve("dist/client");
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, `.${new URL(req.url ?? "/", "http://localhost").pathname}`);
    assert(path.startsWith(`${root}/`));
    res.setHeader("Content-Type", extname(path) === ".html" ? "text/html" : "text/javascript");
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({
  executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
let room: RoomProbeStatus | undefined;
const origin = process.hrtime.bigint();
const elapsed = () => Number(process.hrtime.bigint() - origin) / 1_000_000;
const hostClock: Array<{ monotonicMs: number; wallMs: number }> = [];
const browserEvents: Array<{ slot: number; monotonicMs: number; kind: string; message: string }> =
  [];
const sampleHost = () => {
  if (hostClock.length < 1500) hostClock.push({ monotonicMs: elapsed(), wallMs: Date.now() });
};
sampleHost();
// Independent host samples; no extra Worker requests or changes to scheduler clock semantics.
const hostTimer = setInterval(sampleHost, 20);
try {
  const report = await withDirectRoomWorker(async (base) => {
    const openPages = () =>
      Promise.all(
        Array.from({ length: 4 }, async (_, slot) => {
          const context = await browser.newContext({ viewport: { width: 1050, height: 1000 } }),
            page = await context.newPage();
          const record = (kind: string, message: string) => {
            if (browserEvents.length < 200)
              browserEvents.push({
                slot,
                monotonicMs: elapsed(),
                kind,
                message: message.slice(0, 2000),
              });
          };
          page.on("pageerror", (error) => record("pageerror", String(error)));
          page.on("console", (message) => {
            if (message.type() === "warning" || message.type() === "error")
              record(message.type(), message.text());
          });
          page.on("requestfailed", (request) =>
            record("requestfailed", request.failure()?.errorText ?? "unknown"),
          );
          await page.goto(
            `http://127.0.0.1:${address.port}/network-lab.html?room=${encodeURIComponent(base)}&slot=${slot}`,
          );
          await page.waitForFunction(() => {
            const lab = (
              globalThis as unknown as { controllerNetworkLab?: { status: () => ClientStatus } }
            ).controllerNetworkLab;
            return lab?.status().ready || lab?.status().error;
          });
          await page.locator("#scripted").check();
          return page;
        }),
      );
    const pages = await openPages();
    const read = (includeTimeline = false) =>
      Promise.all(
        pages.map((page) =>
          page.evaluate(
            (include) =>
              (
                globalThis as unknown as {
                  controllerNetworkLab: { status: (include?: boolean) => ClientStatus };
                }
              ).controllerNetworkLab.status(include),
            includeTimeline,
          ),
        ),
      );
    const prepareAndStart = async () => {
      await Promise.all(pages.map((page) => page.locator("#prepare").click()));
      for (let attempt = 0; attempt < 50; attempt++) {
        room = (await (await fetch(`${base}/controller/status`)).json()) as RoomProbeStatus;
        if (
          room.peers.length === 4 &&
          room.peers.every((p) => p.maxQueuedCommands === CONTROLLER_INPUT_PREFILL_TICKS)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(
        room?.peers.every((p) => p.maxQueuedCommands === CONTROLLER_INPUT_PREFILL_TICKS),
        "Input preload incomplete",
      );
      const start = await fetch(`${base}/controller/start`, { method: "POST" });
      assert(start.ok, `Start: ${start.status}`);
    };
    try {
      await prepareAndStart();
      if (recoveryMode) {
        const waitForTick = async (target: number) => {
          let clients: ClientStatus[] = [];
          for (let attempt = 0; attempt < 80; attempt++) {
            clients = await read();
            assert(
              clients.every((c) => !c.error && !c.requiresResync),
              JSON.stringify(
                clients.map((c) => ({ slot: c.slot, error: c.error, tick: c.snapshotTick })),
              ),
            );
            if (clients.every((c) => c.snapshotTick >= target)) return clients;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error("Recovery progression timed out");
        };
        const before = await waitForTick(30);
        const response = await fetch(`${base}/controller/recover`, { method: "POST" });
        assert(response.ok, `Recovery request: ${response.status}`);
        const boundary = (await response.json()) as {
          runEpoch: number;
          tick: number;
          roomMode: string;
        };
        assert.equal(boundary.runEpoch, 2);
        assert.equal(boundary.roomMode, "loading");
        assert(boundary.tick >= 30);
        for (let attempt = 0; attempt < 40; attempt++) {
          if ((await read()).every((c) => c.error?.includes("baseline-replaced"))) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const replaced = await read(true);
        assert(
          replaced.every((c) => c.error?.includes("baseline-replaced")),
          "Old socket generation remained active",
        );
        await Promise.all(
          pages.map(async (page) => {
            await Promise.all([page.waitForEvent("load"), page.locator("#reconnect").click()]);
            await page.waitForFunction(() => {
              const lab = (
                globalThis as unknown as { controllerNetworkLab?: { status: () => ClientStatus } }
              ).controllerNetworkLab;
              return lab?.status().ready || lab?.status().error;
            });
            await page.locator("#scripted").check();
          }),
        );
        const baselines = await read();
        assert(
          baselines.every(
            (c) =>
              c.runEpoch === 2 &&
              c.initialServerTick === boundary.tick &&
              c.sequence === 0 &&
              c.pending === 0,
          ),
        );
        const repeatPage = pages[0];
        assert(repeatPage);
        await repeatPage.locator("#game").focus();
        await repeatPage.keyboard.down("KeyZ");
        await repeatPage.locator("#prepare").focus(); // Blur clears unsampled intent.
        await repeatPage.locator("#game").focus();
        await repeatPage.keyboard.down("KeyZ"); // Still physically held: DOM repeat=true.
        const repeatInput = (await read())[0];
        assert(repeatInput);
        assert.equal(repeatInput?.held, 0, "Repeat recreated released held intent");
        assert.equal(repeatInput?.pendingEdges, 0, "Repeat recreated a cleared action edge");
        await repeatPage.keyboard.up("KeyZ");
        const premature = await fetch(`${base}/controller/start`, { method: "POST" });
        assert.equal(premature.status, 409, "Recovery resumed without fresh preloaded input");
        await prepareAndStart();
        const clients = await waitForTick(boundary.tick + 30);
        assert(
          clients.every((c) =>
            c.receipts.every(
              (r) => !r.correctionChanged && r.correctionX === 0 && r.correctionY === 0,
            ),
          ),
          "Recovered prediction diverged",
        );
        room = (await (await fetch(`${base}/controller/status`)).json()) as RoomProbeStatus;
        assert.equal(room.runEpoch, 2);
        assert.equal(room.recoveries, 1);
        assert.equal(room.clock.fault, null);
        await pages[0]?.screenshot({ path: `${output}/four-player-controller.png` });
        return {
          status: "pass",
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          recordedAt: new Date().toISOString(),
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          sharedSnapshots: 0,
          clients,
          room,
          recovery: { boundary, before, replaced, baselines },
          timelines: (await read(true)).map((client) => ({
            slot: client.slot,
            timeline: client.timeline,
          })),
          repeatNeutralization: { held: repeatInput.held, pendingEdges: repeatInput.pendingEdges },
          scope:
            "Four-browser in-memory authority-approved session rotation and restart at a preserved nonzero tick; no durable crash recovery, automatic reconnect or long-running timing acceptance",
        };
      }
      let clients: ClientStatus[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        clients = await read();
        assert(
          clients.every((c) => !c.error && !c.requiresResync),
          JSON.stringify(
            clients.map((c) => ({ slot: c.slot, error: c.error, tick: c.snapshotTick })),
          ),
        );
        if (clients.every((c) => c.snapshotTick >= 180)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        clients.every((c) => c.snapshotTick >= 180),
        "Controller did not reach 180 ticks",
      );
      room = (await (await fetch(`${base}/controller/status`)).json()) as RoomProbeStatus;
      assert.equal(room.clock.fault, null);
      assert.equal(room.roomMode, "playing");
      for (const client of clients) {
        assert(
          client.receipts.some((r) => r.y < 280 * 256),
          "Missing authoritative jump",
        );
        assert(
          client.receipts.some((r) => r.shape === 2),
          "Missing authoritative crouch",
        );
        assert(
          (client.receipts.at(-1)?.ack ?? 0) >= 177,
          "Missing processed command acknowledgments",
        );
        assert(
          client.receipts.every(
            (r) => r.correctionX === 0 && r.correctionY === 0 && !r.correctionChanged,
          ),
          "Unimpaired prediction correction",
        );
        // Pending includes commands captured since the last 20 Hz snapshot, not just server lead.
        assert(
          client.pending <= 9,
          "Unimpaired client pending input exceeds lead plus snapshot interval",
        );
        assert.equal(client.inputClock?.mode, "running", "Missing independent capture clock");
        assert.equal(client.inputClock.tick, client.sequence, "Capture clock/command divergence");
        assert(client.unsent <= 2, "Normal input batching backlog");
      }
      const common =
        clients[0]?.receipts.filter(
          (r) => r.tick > 0 && clients.every((c) => c.receipts.some((s) => s.tick === r.tick)),
        ) ?? [];
      assert(common.length >= 50, "Insufficient shared snapshots");
      for (const receipt of common)
        assert(
          clients.every(
            (c) => c.receipts.find((r) => r.tick === receipt.tick)?.hash === receipt.hash,
          ),
          "Clients disagree on authoritative world",
        );
      await writeFile(
        `${output}/movement-report.json`,
        JSON.stringify(
          {
            status: "pass",
            baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            recordedAt: new Date().toISOString(),
            browser: browser.version(),
            bundleSha256: createHash("sha256")
              .update(await readFile(`${root}/network-lab.js`))
              .digest("hex"),
            clients,
            sharedSnapshots: common.length,
            scope:
              "Only the completed 180-tick movement/reconciliation stage. The extended input-stop/lease test is reported separately and can fail.",
          },
          null,
          2,
        ),
      );
      await pages[0]?.evaluate(() =>
        (
          globalThis as unknown as { controllerNetworkLab: { stopInput: () => void } }
        ).controllerNetworkLab.stopInput(),
      );
      // Real keyboard events exercise short taps through DOM capture, binary transport and ack.
      // The laboratory consumes combat edges as unavailable; this does not prove combat effects.
      const tapPage = pages[1];
      assert(tapPage);
      const beforeTaps = (await read())[1]?.authoritative?.processedEdgeIds;
      assert(beforeTaps);
      await tapPage.locator("#game").focus();
      for (const key of ["Space", "KeyZ", "KeyX", "KeyE", "KeyV"]) await tapPage.keyboard.down(key);
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (const key of ["Space", "KeyZ", "KeyX", "KeyE", "KeyV"]) await tapPage.keyboard.up(key);
      let stoppedClients: ClientStatus[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        stoppedClients = await read();
        assert(
          stoppedClients.slice(1).every((c) => !c.error),
          "Healthy peer failed during input-stop probe",
        );
        if (stoppedClients.slice(1).every((c) => c.snapshotTick >= 420)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        stoppedClients.slice(1).every((c) => c.snapshotTick >= 420),
        "Input-stop observation timed out",
      );
      room = (await (await fetch(`${base}/controller/status`)).json()) as RoomProbeStatus;
      const stoppedPeer = room.peers.find((peer) => peer.slot === 0);
      assert.equal(stoppedPeer?.closeReason, "lease-expired");
      assert(
        stoppedPeer?.neutralizedAtTick !== null && (stoppedPeer?.neutralizedAtTick ?? 0) > 180,
        "Held intent was not neutralized",
      );
      assert(
        stoppedPeer && stoppedPeer.acknowledgmentOnlyFrames > 0,
        "Missing acknowledgment-only traffic",
      );
      assert(
        room.peers.filter((p) => p.slot !== 0).every((p) => p.active),
        "Healthy leases expired",
      );
      assert.equal(room.clock.fault, null);
      const afterTaps = stoppedClients[1]?.authoritative?.processedEdgeIds;
      assert(afterTaps);
      assert.deepEqual(
        afterTaps,
        beforeTaps.map((id) => id + 1),
        "Lost or duplicated action tap",
      );
      await fetch(`${base}/controller/close`, { method: "POST" });
      await pages[0]?.screenshot({ path: `${output}/four-player-controller.png` });
      return {
        status: "pass",
        baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        recordedAt: new Date().toISOString(),
        browser: browser.version(),
        bundleSha256: createHash("sha256")
          .update(await readFile(`${root}/network-lab.js`))
          .digest("hex"),
        sharedSnapshots: common.length,
        actionTaps: { slot: 1, before: beforeTaps, after: afterTaps },
        stoppedClients,
        timelines: (await read(true)).map((client) => ({
          slot: client.slot,
          timeline: client.timeline,
        })),
        room,
        clients,
        scope:
          "Four isolated Chromium contexts over real WebSockets to direct local workerd; 180-tick movement/reconciliation proof followed by input-stop/lease-expiry through tick 420; not combat load, persistence, full impaired transport or live cadence acceptance",
      };
    } catch (error) {
      room = (await (await fetch(`${base}/controller/status`)).json()) as RoomProbeStatus;
      await writeFile(`${output}/failed-clients.json`, JSON.stringify(await read(true), null, 2));
      await pages[0]?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
      throw error;
    } finally {
      await fetch(`${base}/controller/close`, { method: "POST" }).catch(() => {});
      await Promise.all(pages.map((page) => page.context().close()));
    }
  });
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      sharedSnapshots: report.sharedSnapshots,
      ticks: report.clients.map((c) => c.snapshotTick),
      directory: output,
    }),
  );
} catch (error) {
  await writeFile(
    `${output}/failure.json`,
    `${JSON.stringify({ error: String(error), room }, null, 2)}\n`,
  );
  throw error;
} finally {
  clearInterval(hostTimer);
  sampleHost();
  await writeFile(
    `${output}/diagnostics.json`,
    `${JSON.stringify(
      {
        scope:
          "Independent Node hrtime/wall-clock samples and bounded browser errors; not a CPU profile or proof of the runtime clock's underlying cause",
        node: process.version,
        hostClock,
        browserEvents,
      },
      null,
      2,
    )}\n`,
  );
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
