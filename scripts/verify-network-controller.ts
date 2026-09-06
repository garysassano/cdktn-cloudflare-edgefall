import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { CONTROLLER_INPUT_PREFILL_TICKS } from "../src/shared/diagnostics/controller-workload.js";
import type { RoomProbeStatus } from "../src/shared/diagnostics/room-probe-types.js";
import type { EventReceiver } from "../src/shared/protocol/event-stream.js";
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
  events:
    | (EventReceiver["status"] & {
        counts: Record<string, number>;
        hash: string;
        framesDropped: number;
        gapsInjected: number;
        receipts: Array<{
          cursor: number;
          tick: number;
          counter: number;
          kind: string;
          hash: string;
        }>;
      })
    | null;
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
    enemies: number;
    projectiles: number;
    shots: number;
  }>;
}
const recoveryMode = process.argv.includes("--recovery");
const faultMode = process.argv.includes("--combat-fault");
const eventMode = process.argv.includes("--events");
const combatMode = process.argv.includes("--combat") || faultMode || eventMode;
assert(!(combatMode && recoveryMode), "Combat recovery is not implemented");
assert(!(eventMode && faultMode), "Run event repair and world abort separately");
const workload = combatMode ? "combat" : "controller";
const output = combatMode
  ? eventMode
    ? "dist/network-event-evidence"
    : faultMode
      ? "dist/network-combat-fault-evidence"
      : "dist/network-combat-evidence"
  : recoveryMode
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
  const report = await withDirectRoomWorker(async (base, _assertAlive, workerBundleSha256) => {
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
            `http://127.0.0.1:${address.port}/network-lab.html?room=${encodeURIComponent(base)}&slot=${slot}&mode=${workload}`,
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
        room = (await (await fetch(`${base}/${workload}/status`)).json()) as RoomProbeStatus;
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
      const start = await fetch(`${base}/${workload}/start`, { method: "POST" });
      assert(start.ok, `Start: ${start.status}`);
    };
    try {
      const configureEvents = async (
        slot: number,
        faults: {
          dropNext?: number;
          pauseUntilBaseline?: boolean;
          duplicate?: boolean;
          gapNext?: boolean;
        },
      ) => {
        const page = pages[slot];
        assert(page, "Missing event test client");
        await page.evaluate((faults) => {
          (
            globalThis as unknown as {
              controllerNetworkLab: {
                configureEvents(value: {
                  dropNext?: number;
                  pauseUntilBaseline?: boolean;
                  duplicate?: boolean;
                  gapNext?: boolean;
                }): void;
              };
            }
          ).controllerNetworkLab.configureEvents(faults);
        }, faults);
      };
      if (eventMode) {
        await configureEvents(1, { duplicate: true });
        await configureEvents(2, { dropNext: 1 });
      }
      await prepareAndStart();
      if (combatMode) {
        let clients: ClientStatus[] = [];
        const target = faultMode ? 12 : 90;
        for (let attempt = 0; attempt < 120; attempt++) {
          clients = await read();
          assert(
            clients.every((client) => !client.error && !client.requiresResync),
            JSON.stringify(
              clients.map((client) => ({
                slot: client.slot,
                error: client.error,
                tick: client.snapshotTick,
              })),
            ),
          );
          if (clients.every((client) => client.snapshotTick >= target)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert(
          clients.every((client) => client.snapshotTick >= target),
          "Combat clients did not reach the target tick",
        );
        const sharedEvents =
          clients[0]?.events?.receipts.filter((item) =>
            clients.every((client) =>
              client.events?.receipts.some(
                (other) => other.cursor === item.cursor && other.hash === item.hash,
              ),
            ),
          ).length ?? 0;
        if (!faultMode) {
          assert(sharedEvents >= 100, "Missing shared gameplay event prefix");
          assert(
            clients.every(
              (client) => client.events?.counts.killed === 2 && !client.events.requiresBaseline,
            ),
            "Missing or repeated confirmed kills",
          );
          assert(
            clients.every(
              (client) =>
                new Set(client.events?.receipts.map((item) => item.cursor)).size ===
                client.events?.receipts.length,
            ),
            "Duplicate confirmed event consumption",
          );
        }
        if (eventMode) {
          assert((clients[1]?.events?.duplicates ?? 0) > 0, "Duplicate delivery was not exercised");
          assert.equal(clients[2]?.events?.framesDropped, 1);
          assert.equal(
            clients[2]?.events?.baselines,
            0,
            "Short gap unnecessarily reset the event baseline",
          );
          await configureEvents(0, { pauseUntilBaseline: true });
          for (let attempt = 0; attempt < 160; attempt++) {
            clients = await read();
            assert(
              clients.every((client) => !client.error && !client.requiresResync),
              JSON.stringify(
                clients.map((client) => ({
                  slot: client.slot,
                  error: client.error,
                  tick: client.snapshotTick,
                })),
              ),
            );
            const repaired = clients[0];
            if (
              repaired?.events?.baselines === 1 &&
              repaired.snapshotTick >= repaired.events.baselineTick + 30
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const repaired = clients[0]?.events;
          assert(
            repaired &&
              repaired.baselines === 1 &&
              repaired.omittedByBaseline > 0 &&
              repaired.cursor > repaired.baselineCursor,
            "Event prefix did not repair and resume",
          );
          assert(
            clients.slice(1).every((client) => client.events?.baselines === 0),
            "One lagging reader reset healthy event streams",
          );
          assert(
            clients.every(
              (client) => client.events?.counts.killed === 2 && !client.events.requiresBaseline,
            ),
            "Baseline replayed terminal events",
          );
          await configureEvents(3, { gapNext: true });
          for (let attempt = 0; attempt < 100; attempt++) {
            clients = await read();
            assert(
              clients.every((client) => !client.error && !client.requiresResync),
              JSON.stringify(clients.map((client) => ({ slot: client.slot, error: client.error }))),
            );
            const repaired = clients[3];
            if (
              repaired?.events?.baselines === 1 &&
              repaired.snapshotTick >= repaired.events.baselineTick + 12
            )
              break;
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          assert.equal(clients[3]?.events?.gapsInjected, 1);
          assert.equal(
            clients[3]?.events?.baselines,
            1,
            "Client gap request did not install a baseline",
          );
          assert(
            clients[3]?.events && clients[3].events.cursor > clients[3].events.baselineCursor,
            "Client gap repair did not resume events",
          );
          assert.deepEqual(
            clients.map((client) => client.events?.baselines),
            [1, 0, 0, 1],
          );
          assert(
            clients.every(
              (client) => client.events?.counts.killed === 2 && !client.events.requiresBaseline,
            ),
            "Gap repair replayed terminal events",
          );
        }
        let aborted = null;
        if (faultMode) {
          const injection = await fetch(`${base}/${workload}/fail-next-tick`, { method: "POST" });
          assert.equal(injection.status, 200);
          aborted = (await injection.json()) as {
            tick: number;
            acknowledgments: unknown;
            combat: unknown;
            events: unknown;
            eventCursor: number;
          };
          for (let attempt = 0; attempt < 80; attempt++) {
            clients = await read();
            if (clients.every((client) => client.error?.includes("clock-fault"))) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert(
            clients.every((client) => client.error?.includes("clock-fault")),
            "Failed cohort did not close",
          );
        }
        room = (await (await fetch(`${base}/${workload}/status`)).json()) as RoomProbeStatus;
        assert(room.combat, "Missing committed combat state");
        if (aborted) {
          assert.equal(room.tick, aborted.tick);
          assert.equal(room.clock.tick, aborted.tick);
          assert.deepEqual(room.combat.world, aborted.combat);
          assert.deepEqual(room.combat.events, aborted.events);
          assert.equal(room.combat.eventCursor, aborted.eventCursor);
          assert.deepEqual(
            room.inputStreams
              .map((input) => input.acknowledgment)
              .sort((a, b) => a.playerId - b.playerId),
            aborted.acknowledgments,
          );
          assert(room.inputStreams.every((input) => input.requiresResync));
          assert.match(room.worldFailure ?? "", /injected-combat-commit-failure/);
        } else {
          assert.equal(room.worldFailure, null);
          assert.equal(room.combat.world.encounter.phase, "complete");
          assert.equal(
            room.combat.world.encounter.kills.reduce((sum, entry) => sum + entry.count, 0),
            2,
          );
          assert(room.peers.every((peer) => peer.active && !peer.lastInputError));
          assert(
            room.inputStreams.every(
              (stream) => stream.delivery.event > 0 && stream.pendingEventBaseline === null,
            ),
            "Event delivery is not acknowledged or repair acceptance is pending",
          );
          if (eventMode) {
            assert.equal(room.peers.find((peer) => peer.slot === 0)?.eventBaselines, 1);
            const repaired = clients[0]?.events;
            assert(
              repaired &&
                (room.inputStreams.find((stream) => stream.acknowledgment.playerId === 1)?.delivery
                  .event ?? 0) >= repaired.baselineCursor,
              "Full event baseline was not acknowledged",
            );
          }
          assert(
            clients.every(
              (client) =>
                client.receipts.some((receipt) => receipt.projectiles > 0) &&
                client.receipts.some((receipt) => receipt.enemies === 0) &&
                client.receipts.some((receipt) => receipt.shots > 0),
            ),
          );
          assert(
            clients.every((client) =>
              client.receipts.every(
                (receipt) => receipt.correctionX === 0 && receipt.correctionY === 0,
              ),
            ),
            "Combat movement correction",
          );
        }
        const common =
          clients[0]?.receipts.filter(
            (receipt) =>
              receipt.tick > 0 &&
              clients.every((client) =>
                client.receipts.some(
                  (other) => other.tick === receipt.tick && other.hash === receipt.hash,
                ),
              ),
          ) ?? [];
        assert(common.length >= (faultMode ? 4 : 30), "Missing shared committed combat snapshots");
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
          sharedEvents,
          workerBundleSha256,
          clients,
          room,
          aborted,
          scope: faultMode
            ? "Four-browser real workerd abort after world evaluation: no world, event or acknowledgment commit; explicit cohort recovery required"
            : eventMode
              ? "Four-browser acknowledged combat event prefixes, duplicate suppression, dropped-frame replay and one-reader ring-expiry/full-baseline repair; predicted effects, durable recovery and production integration remain open"
              : "Four-browser authoritative combat snapshots and acknowledged event prefixes; predicted effects, global action prediction, durable recovery and production integration remain open",
        };
      }
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
        const response = await fetch(`${base}/${workload}/recover`, { method: "POST" });
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
        const premature = await fetch(`${base}/${workload}/start`, { method: "POST" });
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
        room = (await (await fetch(`${base}/${workload}/status`)).json()) as RoomProbeStatus;
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
      room = (await (await fetch(`${base}/${workload}/status`)).json()) as RoomProbeStatus;
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
      room = (await (await fetch(`${base}/${workload}/status`)).json()) as RoomProbeStatus;
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
      await fetch(`${base}/${workload}/close`, { method: "POST" });
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
      room = (await (await fetch(`${base}/${workload}/status`)).json()) as RoomProbeStatus;
      await writeFile(`${output}/failed-clients.json`, JSON.stringify(await read(true), null, 2));
      await pages[0]?.screenshot({ path: `${output}/failure.png` }).catch(() => {});
      throw error;
    } finally {
      await fetch(`${base}/${workload}/close`, { method: "POST" }).catch(() => {});
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
