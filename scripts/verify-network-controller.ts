import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { CONTROLLER_INPUT_PREFILL_TICKS } from "../src/shared/diagnostics/controller-workload.js";
import type { RoomProbeStatus } from "../src/shared/diagnostics/room-probe-types.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import type { EventReceiver } from "../src/shared/protocol/event-stream.js";
import type { CombatSnapshot, FullSnapshot } from "../src/shared/protocol/snapshot-schema.js";
import type { ConnectionStatus } from "../src/shared/session/connection.js";
import { withDirectRoomWorker } from "./lib/local-worker.js";
import { loadRoomIfNeeded, roomHostCommand } from "./lib/room-host-control.js";
import { verifyAreaCombat } from "./lib/verify-area-combat.js";
import { verifyCombatCampaign } from "./lib/verify-combat-campaign.js";
import { verifyFootCombat } from "./lib/verify-foot-combat.js";
import { verifyHmgCombat } from "./lib/verify-hmg-combat.js";
import { verifyHostileCombat } from "./lib/verify-hostile-combat.js";
import { verifyLoadingConnections } from "./lib/verify-loading-connections.js";
import { verifyOrdnanceCombat } from "./lib/verify-ordnance-combat.js";
import { verifyRocketCombat } from "./lib/verify-rocket-combat.js";
import { verifyRoomPhases } from "./lib/verify-room-phases.js";
import { verifyShieldCombat } from "./lib/verify-shield-combat.js";
import { verifySupportCombat } from "./lib/verify-support-combat.js";
import { verifyTankCombat } from "./lib/verify-tank-combat.js";

interface ClientStatus {
  documentId: string;
  connection: ConnectionStatus;
  connectionHistory: Array<{
    generation: number;
    runEpoch: number;
    connectionEpoch: number;
    baselineTick: number;
    previousTick: number;
    rewindTicks: number;
  }>;
  combatBaseline: CombatSnapshot | null;
  timeline: unknown[];
  slot: number;
  runEpoch: number;
  connectionEpoch: number;
  baselineEventCursor: number;
  initialActor: FullSnapshot["players"][number] | null;
  initialServerTick: number;
  ready: boolean;
  prepared: boolean;
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
  authoritative: FullSnapshot["players"][number] | null;
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
    continuationHash: string | null;
  }>;
}
const recoveryMode = process.argv.includes("--recovery");
const combatRecoveryMode = process.argv.includes("--combat-recovery");
const phaseMode = process.argv.includes("--combat-phases");
const loadingMode = process.argv.includes("--combat-loading") || phaseMode;
const combatReconnectMode = process.argv.includes("--combat-reconnect") || loadingMode;
const automaticMode = process.argv.includes("--combat-auto-reconnect");
const campaignMode = process.argv.includes("--combat-campaign");
const areaMode = process.argv.includes("--combat-shotgun")
  ? "shotgun"
  : process.argv.includes("--combat-flame")
    ? "flame"
    : null;
const shieldMode = process.argv.includes("--combat-guard");
const tankMode = process.argv.includes("--combat-tank");
const supportMode = process.argv.includes("--combat-support");
const rocketMode = process.argv.includes("--combat-rocket");
const hmgMode = process.argv.includes("--combat-hmg");
const ordnanceMode = process.argv.includes("--combat-ordnance");
const hostileMode = process.argv.includes("--combat-hostile");
const footMode = process.argv.includes("--combat-melee")
  ? "melee"
  : process.argv.includes("--combat-grenade")
    ? "grenade"
    : null;
const faultMode = process.argv.includes("--combat-fault");
const baselineMode = process.argv.includes("--combat-baseline");
const eventMode = process.argv.includes("--events") || baselineMode;
const combatMode =
  process.argv.includes("--combat") ||
  faultMode ||
  eventMode ||
  combatRecoveryMode ||
  combatReconnectMode ||
  automaticMode ||
  campaignMode ||
  hostileMode ||
  !!footMode ||
  shieldMode ||
  !!areaMode ||
  tankMode ||
  ordnanceMode ||
  hmgMode ||
  supportMode ||
  rocketMode;
assert(
  !(
    footMode ||
    shieldMode ||
    areaMode ||
    tankMode ||
    ordnanceMode ||
    hmgMode ||
    supportMode ||
    rocketMode
  ) ||
    !(
      hostileMode ||
      campaignMode ||
      automaticMode ||
      combatReconnectMode ||
      combatRecoveryMode ||
      faultMode ||
      eventMode ||
      recoveryMode
    ),
  "Run foot combat separately",
);
assert(
  [
    process.argv.includes("--combat-melee"),
    process.argv.includes("--combat-grenade"),
    shieldMode,
    process.argv.includes("--combat-shotgun"),
    process.argv.includes("--combat-flame"),
    tankMode,
    ordnanceMode,
    hmgMode,
    supportMode,
    rocketMode,
  ].filter(Boolean).length <= 1,
  "Run each foot action in its own fresh room",
);
assert(
  !hostileMode ||
    !(
      campaignMode ||
      automaticMode ||
      combatReconnectMode ||
      combatRecoveryMode ||
      faultMode ||
      eventMode ||
      recoveryMode
    ),
  "Run hostile combat separately",
);
assert(
  !(
    automaticMode &&
    (combatReconnectMode || combatRecoveryMode || faultMode || eventMode || recoveryMode)
  ),
  "Run automatic reconnect separately",
);
assert(
  !(combatReconnectMode && (combatRecoveryMode || faultMode || eventMode || recoveryMode)),
  "Run per-player reconnect separately",
);
assert(!(combatMode && recoveryMode), "Use --combat-recovery for durable combat recovery");
assert(
  !(combatRecoveryMode && (faultMode || eventMode)),
  "Run durable recovery separately from event/world faults",
);
assert(!(eventMode && faultMode), "Run event repair and world abort separately");
const workload = combatMode ? "combat" : "controller";
const output = rocketMode
  ? "dist/network-combat-rocket-evidence"
  : supportMode
    ? "dist/network-combat-support-evidence"
    : hmgMode
      ? "dist/network-combat-hmg-evidence"
      : ordnanceMode
        ? "dist/network-combat-ordnance-evidence"
        : tankMode
          ? "dist/network-combat-tank-evidence"
          : areaMode
            ? `dist/network-combat-${areaMode}-evidence`
            : shieldMode
              ? "dist/network-combat-guard-evidence"
              : footMode
                ? `dist/network-combat-${footMode}-evidence`
                : hostileMode
                  ? "dist/network-combat-hostile-evidence"
                  : campaignMode
                    ? "dist/network-combat-campaign-evidence"
                    : automaticMode
                      ? "dist/network-combat-auto-evidence"
                      : combatReconnectMode
                        ? loadingMode
                          ? phaseMode
                            ? "dist/network-combat-phase-evidence"
                            : "dist/network-combat-loading-evidence"
                          : "dist/network-combat-reconnect-evidence"
                        : combatRecoveryMode
                          ? "dist/network-combat-recovery-evidence"
                          : baselineMode
                            ? "dist/network-combat-baseline-evidence"
                            : combatMode
                              ? eventMode
                                ? "dist/network-event-evidence"
                                : faultMode
                                  ? "dist/network-combat-fault-evidence"
                                  : "dist/network-combat-evidence"
                              : recoveryMode
                                ? "dist/network-controller-recovery-evidence"
                                : "dist/network-controller-evidence";
// This generated directory belongs to this invocation, including scenario-specific screenshots.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
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
  const runProbe = async (
    url: string,
    _alive: () => void,
    workerHash: string,
    restart: () => Promise<string>,
  ) => {
    const workerBundleSha256 = workerHash;
    const sources = [];
    for (const file of [
      "scripts/verify-network-controller.ts",
      "scripts/lib/local-worker.ts",
      "scripts/lib/room-host-control.ts",
      ...(hmgMode ? ["scripts/lib/verify-hmg-combat.ts"] : []),
      ...(supportMode ? ["scripts/lib/verify-support-combat.ts"] : []),
      ...(rocketMode ? ["scripts/lib/verify-rocket-combat.ts"] : []),
    ])
      sources.push({
        file,
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      });
    await writeFile(
      `${output}/execution.json`,
      `${JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          browser: browser.version(),
          sources,
          scope:
            "Captured before opening clients; retained for pass or failure. Working-tree bundle hashes do not assert a clean base commit. Listed verifier sources cover the entry, Worker launcher, host control and selected HMG/support helper.",
        },
        null,
        2,
      )}\n`,
    );
    let base = url;
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
            if (message.type() === "warning" || message.type() === "error") {
              const source = message.location().url;
              record(
                message.type(),
                `${message.text()}${source ? ` ${new URL(source).pathname}` : ""}`,
              );
            }
          });
          page.on("requestfailed", (request) =>
            record(
              "requestfailed",
              `${request.failure()?.errorText ?? "unknown"} ${new URL(request.url()).pathname}`,
            ),
          );
          page.on("response", (response) => {
            if (response.status() >= 400)
              record("http-error", `${response.status()} ${new URL(response.url()).pathname}`);
          });
          await page.goto(
            `http://127.0.0.1:${address.port}/network-lab.html?room=${encodeURIComponent(base)}&slot=${slot}&mode=${workload}&manual=${automaticMode || campaignMode || hostileMode || footMode || shieldMode || areaMode || tankMode || ordnanceMode || hmgMode || supportMode || rocketMode ? 0 : 1}`,
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
      if (combatMode) await loadRoomIfNeeded(base, pages);
      const clients = await read();
      await Promise.all(
        pages.map((page, slot) =>
          clients[slot]?.prepared ? Promise.resolve() : page.locator("#prepare").click(),
        ),
      );
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
      const start = combatMode
        ? await roomHostCommand(base, pages, "start")
        : await fetch(`${base}/${workload}/start`, { method: "POST" });
      assert.equal(start.status, 200, `Start: ${start.status}`);
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
        if (baselineMode) await configureEvents(0, { pauseUntilBaseline: true });
        await configureEvents(1, { duplicate: true });
        await configureEvents(2, { dropNext: 1 });
      }
      if (rocketMode) {
        const rocket = await verifyRocketCombat(pages, base, output);
        room = rocket.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          rocket,
          clients: rocket.clients,
          sharedSnapshots: rocket.common.length,
          room,
          scope:
            "Four real keyboards fire two short launcher taps each into an authoritative local workerd room. Flight snapshots, one ammo debit per release, explosions, kill credit and deduplicated events agree. Engineering content; deployed timing and final media remain open.",
        };
      }
      if (supportMode) {
        const support = await verifySupportCombat(pages, base, output);
        room = support.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          support,
          clients: support.clients,
          sharedSnapshots: support.common.length,
          room,
          scope:
            "Four real keyboard clients send two short fire taps each. Their accepted attacks destroy authored support, both enemies fall under gravity into the terminal boundary, and clients agree on geometry, destruction attribution and the terminal ledger. Local workerd engineering proof; deployed timing and final media remain open.",
        };
      }
      if (hmgMode) {
        const hmg = await verifyHmgCombat(pages, base, output);
        room = hmg.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          hmg,
          clients: hmg.clients,
          sharedSnapshots: hmg.common.length,
          room,
          scope:
            "Four real keyboard clients over local workerd WebSockets slew HMGs through authored directions while firing, mirror, jump/down-fire, crouch and resume idle aim. Exact shared snapshots and deduplicated events; engineering graphics and no deployed timing acceptance.",
        };
      }
      if (ordnanceMode) {
        const ordnance = await verifyOrdnanceCombat(pages, base, output);
        room = ordnance.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          ordnance,
          clients: ordnance.clients,
          sharedSnapshots: ordnance.common.length,
          room,
          scope:
            "Four Chromium keyboard clients throw from a moving lift and observe a proved grenade crush, exact platform snapshots and duplicate event delivery. Engineering graphics; no deployed timing acceptance.",
        };
      }
      if (tankMode) {
        const tank = await verifyTankCombat(pages, base, output);
        room = tank.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          tank,
          clients: tank.clients,
          sharedSnapshots: tank.common.length,
          room,
          scope:
            "Four Chromium keyboard clients over local workerd WebSockets board, jump, slew the turret, drive, fire, defeat rifle infantry and exit. Exact shared snapshots and duplicate event delivery; engineering graphics and authoritative tank movement, no deployed timing acceptance.",
        };
      }
      if (areaMode) {
        const area = await verifyAreaCombat(pages, base, output, areaMode);
        room = area.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          area,
          clients: area.clients,
          sharedSnapshots: area.common.length,
          room,
          scope:
            "Four Chromium contexts over local workerd WebSockets; actual shotgun/flame keyboard action, exact public rectangles, one charge per player, material damage and duplicate event delivery. Engineering range; no final media or deployed timing acceptance.",
        };
      }
      if (shieldMode) {
        const shield = await verifyShieldCombat(pages, base, output);
        room = shield.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          shield,
          clients: shield.clients,
          sharedSnapshots: shield.common.length,
          room,
          scope:
            "Four Chromium contexts over local workerd WebSockets; real jump/crouch evasion, shield break and stun, return-fire kills against mixed shield/rifle infantry, and deduplicated events. Engineering geometry; no authored mission or deployed timing acceptance.",
        };
      }
      if (footMode) {
        const foot = await verifyFootCombat(pages, base, output, footMode);
        room = foot.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          foot,
          clients: foot.clients,
          sharedSnapshots: foot.common.length,
          room,
          scope:
            "Four Chromium contexts over local workerd WebSockets; actual contextual knife or discrete grenade keyboard input, snapshot agreement and duplicate event delivery. Engineering range, no authored missions or deployed timing acceptance.",
        };
      }
      if (hostileMode) {
        const hostile = await verifyHostileCombat(pages, base, output);
        room = hostile.final;
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          hostile,
          clients: hostile.clients,
          sharedSnapshots: hostile.common.length,
          room,
          scope:
            "Four Chromium contexts over local workerd WebSockets; real keyboard crouch evasion, rifle damage, player reconciliation and return-fire kill credit. Engineering geometry, no authored missions or deployed timing acceptance.",
        };
      }
      if (campaignMode) {
        const campaign = await verifyCombatCampaign(pages, base);
        room = campaign.resumed;
        await pages[0]?.screenshot({ path: `${output}/continued-party.png` });
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          workerBundleSha256,
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          campaign,
          clients: campaign.clients,
          sharedSnapshots: campaign.common.length,
          room,
          scope:
            "Four Chromium contexts, actual keyboard falls, delayed final persistence, signed host continue and same-document reconnection with fresh input; no authored missions, deployed durability or long soak acceptance.",
        };
      }
      const phases = phaseMode ? await verifyRoomPhases(pages, base, restart) : null;
      if (phases)
        await writeFile(
          `${output}/phase-report.json`,
          `${JSON.stringify(
            {
              status: "pass",
              recordedAt: new Date().toISOString(),
              workerBundleSha256,
              browser: browser.version(),
              phases,
              scope:
                "Lobby admission, signed host command fences, host succession, waiting takeover, persisted empty lobby and same-document cold return. The subsequent playing regression is reported separately.",
            },
            null,
            2,
          )}\n`,
        );
      if (combatMode) await loadRoomIfNeeded(base, pages);
      const loading = loadingMode ? await verifyLoadingConnections(pages, base) : null;
      if (loading)
        await writeFile(
          `${output}/loading-report.json`,
          `${JSON.stringify(
            {
              status: "pass",
              recordedAt: new Date().toISOString(),
              workerBundleSha256,
              browser: browser.version(),
              loading,
              scope:
                "Loading takeover, same-document reentry and the fresh-input start barrier; subsequent combat is reported separately.",
            },
            null,
            2,
          )}\n`,
        );
      await prepareAndStart();
      if (automaticMode) {
        const status = async () => {
          room = (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
          return room;
        };
        const until = async (predicate: (clients: ClientStatus[]) => boolean) => {
          for (let i = 0; i < 240; i++) {
            const clients = await read();
            assert(
              clients.every(
                (c) => !c.error && (!c.requiresResync || c.connection.phase !== "connected"),
              ),
              JSON.stringify(
                clients.map((c) => ({ slot: c.slot, error: c.error, connection: c.connection })),
              ),
            );
            if (predicate(clients)) return clients;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error("Automatic reconnect timed out");
        };
        const before = await until((cs) => cs.every((c) => c.snapshotTick >= 45));
        const cut = await fetch(`${base}/combat/disconnect-peer?slot=1`, { method: "POST" });
        assert(cut.ok);
        const resumed = await until(
          (cs) =>
            cs.every((c) => c.ready && c.snapshotTick >= 90) &&
            cs[1]?.connectionEpoch === (before[1]?.connectionEpoch ?? 0) + 1,
        );
        for (const [slot, current] of resumed.entries()) {
          const prior = before[slot];
          assert(prior);
          assert.equal(current.documentId, prior.documentId, "Reconnect reloaded the page");
          assert.equal(current.runEpoch, prior.runEpoch);
          if (slot === 1) {
            assert.equal(current.initialActor?.weapon.id, prior.authoritative?.weapon.id);
            assert(
              (current.initialActor?.weapon.ammo ?? 0) <= (prior.authoritative?.weapon.ammo ?? 0),
            );
            assert.equal(current.initialActor?.lives, prior.authoritative?.lives);
            assert.equal(current.receipts[0]?.ack, 0);
            assert.equal(current.events?.counts.killed ?? 0, 0);
          } else {
            assert.equal(current.connectionEpoch, prior.connectionEpoch);
            assert(current.sequence > prior.sequence);
            assert.deepEqual(
              current.events?.receipts.slice(0, prior.events?.receipts.length),
              prior.events?.receipts,
            );
          }
        }
        const stalledPage = pages[2];
        assert(stalledPage);
        await stalledPage.evaluate(() => {
          const until = performance.now() + 350;
          while (performance.now() < until) {
            /* Deliberate bounded browser main-thread stall. */
          }
        });
        const afterStall = await until(
          (cs) =>
            cs.every((c) => c.ready) &&
            cs[2]?.connectionEpoch === (resumed[2]?.connectionEpoch ?? 0) + 1 &&
            (cs[2]?.sequence ?? 0) >= 20,
        );
        assert(afterStall.every((c, slot) => c.documentId === before[slot]?.documentId));
        const beforeRestart = await status();
        const nextBase = await restart();
        assert.equal(nextBase, base, "Restart changed the service origin");
        const cold = await status();
        assert.equal(cold.roomMode, "loading");
        const restored = await until((cs) =>
          cs.every((c) => c.ready && c.runEpoch === cold.runEpoch),
        );
        for (const [slot, client] of restored.entries()) {
          assert.equal(client.documentId, before[slot]?.documentId);
          assert.equal(client.sequence, 0);
          assert.equal(client.held, 0);
          assert.equal(client.pending, 0);
          assert.equal(client.initialServerTick, cold.tick);
          const boundary = client.connectionHistory.at(-1);
          assert(boundary);
          assert.equal(boundary.rewindTicks, Math.max(0, boundary.previousTick - cold.tick));
          assert(boundary.rewindTicks <= 30);
          assert.equal(client.events?.counts.killed ?? 0, 0);
        }
        await prepareAndStart();
        const continued = await until((cs) => cs.every((c) => c.snapshotTick >= cold.tick + 30));
        const control = async (
          method: "pauseConnection" | "resumeConnection",
          slots = [0, 1, 2, 3],
        ) =>
          Promise.all(
            pages
              .filter((_, slot) => slots.includes(slot))
              .map((page) =>
                page.evaluate((method) => {
                  const lab = (
                    globalThis as unknown as {
                      controllerNetworkLab: {
                        pauseConnection(): void;
                        resumeConnection(): void;
                      };
                    }
                  ).controllerNetworkLab;
                  lab[method]();
                }, method),
              ),
          );
        // Retire the transports deliberately so no automatic retry can hide the empty boundary.
        for (let i = 0; i < 60; i++) {
          const current = await status();
          if (
            (current.durability?.queuedTicks ?? 0) >= 3 &&
            (current.durability?.queuedTicks ?? 0) <= 8
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await control("pauseConnection");
        let empty = await status();
        for (let i = 0; i < 80 && (!empty.emptyPause || empty.roomMode !== "paused-empty"); i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          empty = await status();
        }
        assert.equal(empty.roomMode, "paused-empty");
        assert.equal(empty.clock.tick, empty.tick);
        assert.equal(empty.clock.timerPending, false);
        assert.equal(empty.durability?.committedTick, empty.tick);
        assert.equal(empty.durability?.backlogTicks, 0);
        const tail = empty.persistenceCommits.at(-1);
        assert(
          tail && tail.throughTick - tail.fromTick + 1 < 15,
          "The fixture did not exercise a short pause tail",
        );
        assert.equal(
          empty.alarmAtMs,
          Math.max(...(empty.membership?.members.map((m) => m.reservedUntilMs) ?? [])),
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        const stillEmpty = await status();
        assert.equal(stillEmpty.tick, empty.tick);
        assert.equal(stillEmpty.peers.filter((p) => p.active).length, 0);
        assert.equal(await restart(), base);
        const coldPaused = await status();
        assert.notEqual(coldPaused.instanceId, empty.instanceId);
        assert.equal(coldPaused.roomMode, "paused-empty");
        assert.deepEqual(coldPaused.emptyPause, empty.emptyPause);
        assert.equal(coldPaused.alarmAtMs, empty.alarmAtMs);
        // A reserved profile's ordinary connection request now restores the room; no /recover call.
        await control("resumeConnection");
        const reloaded = await until((cs) =>
          cs.every((c) => c.ready && c.runEpoch === empty.runEpoch + 1),
        );
        const boundary = await status();
        assert.equal(boundary.tick, empty.tick);
        assert.equal(boundary.roomMode, "loading");
        assert.equal(boundary.alarmAtMs, null);
        assert(
          reloaded.every(
            (c, slot) => c.documentId === before[slot]?.documentId && c.sequence === 0,
          ),
        );
        await prepareAndStart();
        const clients = await until((cs) => cs.every((c) => c.snapshotTick >= boundary.tick + 36));
        const finalRoom = await status();
        const common =
          clients[0]?.receipts.filter((r) =>
            clients.every((c) => c.receipts.some((v) => v.tick === r.tick && v.hash === r.hash)),
          ) ?? [];
        assert(common.length >= 10);
        assert(
          clients.every((c) => c.receipts.every((r) => r.correctionX === 0 && r.correctionY === 0)),
        );
        assert(
          clients.every(
            (c) =>
              (c.events?.counts.killed ?? 0) === 0 &&
              c.combatBaseline?.kills.reduce((n, k) => n + k.count, 0) === 2,
          ),
        );
        // Losing the existing browser profile must stop resume, not mint a replacement identity.
        const owner = pages[0];
        assert(owner);
        await owner.context().clearCookies();
        const profileCut = await fetch(`${base}/combat/disconnect-peer?slot=0`, {
          method: "POST",
        });
        assert(profileCut.ok);
        let denied = await read();
        for (let i = 0; i < 120 && denied[0]?.connection.phase !== "stopped"; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          denied = await read();
        }
        assert.equal(denied[0]?.connection.reason, "profile-required");
        assert.equal(denied[0]?.documentId, before[0]?.documentId);
        assert.equal(
          (await owner.context().cookies(base)).length,
          0,
          "Automatic retry minted another profile",
        );
        const afterDenial = await status();
        assert(afterDenial.peers.filter((p) => p.active).length === 3);
        // An intentional takeover is terminal for the retired tab; automatic retries must not fight it.
        const retiredPage = pages[3];
        assert(retiredPage);
        const replacementPage = await retiredPage.context().newPage();
        await replacementPage.goto(`${retiredPage.url()}&scripted=1`);
        await replacementPage.waitForFunction(
          () =>
            (
              globalThis as unknown as { controllerNetworkLab?: { status: () => ClientStatus } }
            ).controllerNetworkLab?.status().ready,
        );
        const replaced = await retiredPage.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status: () => ClientStatus } }
          ).controllerNetworkLab.status(),
        );
        assert.equal(replaced.connection.phase, "stopped");
        assert.equal(replaced.connection.reason, "replaced");
        assert.equal(replaced.connection.retryAtMs, null);
        pages[3] = replacementPage;
        await retiredPage.close();
        const replacementClient = (await read())[3];
        assert(replacementClient);
        assert.equal(replacementClient.connectionEpoch, replaced.connectionEpoch + 1);
        await control("pauseConnection");
        let beforeSolo = await status();
        for (let i = 0; i < 80 && !beforeSolo.emptyPause; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          beforeSolo = await status();
        }
        assert(beforeSolo.emptyPause);
        await control("resumeConnection", [1]);
        const soloPage = pages[1];
        assert(soloPage);
        await soloPage.waitForFunction(
          () =>
            (
              globalThis as unknown as {
                controllerNetworkLab: { status(): ClientStatus };
              }
            ).controllerNetworkLab.status().ready,
        );
        const soloBaseline = (await read())[1];
        assert(soloBaseline && soloBaseline.error === null);
        assert.equal(soloBaseline.sequence, 0);
        assert.equal(soloBaseline.initialServerTick, beforeSolo.tick);
        assert.equal(soloBaseline.documentId, before[1]?.documentId);
        await soloPage.locator("#prepare").click();
        assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
        await soloPage.waitForFunction(
          (tick) =>
            (
              globalThis as unknown as {
                controllerNetworkLab: { status(): ClientStatus };
              }
            ).controllerNetworkLab.status().snapshotTick >= tick,
          beforeSolo.tick + 24,
        );
        const soloContinued = (await read())[1];
        assert(soloContinued && soloContinued.error === null);
        assert.equal(soloContinued.events?.counts.killed ?? 0, 0);
        const soloRoom = await status();
        assert.equal(soloRoom.peers.filter((p) => p.active).length, 1);
        await control("pauseConnection");
        let expiring = await status();
        for (let i = 0; i < 80 && !expiring.emptyPause; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          expiring = await status();
        }
        assert.equal(expiring.roomMode, "paused-empty");
        assert(expiring.alarmAtMs && expiring.emptyPause);
        assert.equal(await restart(), base);
        process.stdout.write(
          `${JSON.stringify({ stage: "waiting-for-real-expiry-alarm", deadlineMs: expiring.alarmAtMs })}\n`,
        );
        const expiryStarted = performance.now();
        let expired = await status();
        while (expired.roomMode !== "expired" && performance.now() - expiryStarted < 120_000) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          expired = await status();
        }
        assert.equal(expired.roomMode, "expired", "Durable expiry alarm did not finish");
        assert(expired.alarmDeliveries >= 1);
        assert.equal(expired.tick, expiring.tick);
        assert.equal(expired.clock.timerPending, false);
        assert.equal(expired.alarmAtMs, null);
        const expiryWaitMs = performance.now() - expiryStarted;
        const returning = pages[1];
        assert(returning);
        await returning.evaluate(() =>
          (
            globalThis as unknown as {
              controllerNetworkLab: { resumeConnection(): void };
            }
          ).controllerNetworkLab.resumeConnection(),
        );
        await returning.waitForFunction(
          () =>
            (
              globalThis as unknown as {
                controllerNetworkLab: { status(): ClientStatus };
              }
            ).controllerNetworkLab.status().connection.phase === "stopped",
        );
        const afterExpiry = (await read())[1];
        assert.equal(afterExpiry?.connection.reason, "room-ended");
        assert.equal((await fetch(`${base}/combat/recover`, { method: "POST" })).status, 409);
        assert.equal(await restart(), base);
        const coldExpired = await status();
        assert.equal(coldExpired.roomMode, "expired");
        assert.equal(coldExpired.tick, expired.tick);
        assert.equal(coldExpired.runEpoch, expired.runEpoch);
        return {
          status: "pass",
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          recordedAt: new Date().toISOString(),
          browser: browser.version(),
          workerBundleSha256,
          sharedSnapshots: common.length,
          before,
          resumed,
          afterStall,
          beforeRestart,
          cold,
          restored,
          continued,
          empty,
          stillEmpty,
          coldPaused,
          boundary,
          reloaded,
          clients,
          room: finalRoom,
          denied,
          afterDenial,
          replaced,
          replacementClient,
          beforeSolo,
          soloBaseline,
          soloContinued,
          soloRoom,
          expiring,
          expired,
          coldExpired,
          afterExpiry,
          expiryWaitMs,
          scope:
            "Four real Chromium contexts recover after a peer disconnect, browser stall and same-origin process restart. Explicit transport retirement exposes the durable empty pause: the short journal tail survives another process, and an ordinary reserved-profile connection restores the exact tick without /recover. A real 90-second reservation alarm expires the empty room across process replacement and the terminal checkpoint survives another restart. Fresh input/start remains explicit. Production v3, all-mode admission, hostile/vehicle reentry and sustained timing remain open.",
        };
      }
      if (combatReconnectMode) {
        const status = async () => {
          room = (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
          return room;
        };
        const waitTick = async (tick: number) => {
          for (let attempt = 0; attempt < 120; attempt++) {
            const clients = await read();
            assert(
              clients.every((c) => !c.error && !c.requiresResync),
              JSON.stringify(
                clients.map((c) => ({ slot: c.slot, tick: c.snapshotTick, error: c.error })),
              ),
            );
            if (clients.every((c) => c.snapshotTick >= tick)) return clients;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error("Reconnect progression timed out");
        };
        const before = await waitTick(42),
          beforeRoom = await status();
        const denied = (slot: number, headers: Record<string, string>) =>
          new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = httpRequest(
              `${base}/combat/connect?slot=${slot}`,
              {
                headers: {
                  ...headers,
                  Upgrade: "websocket",
                  Connection: "Upgrade",
                  "Sec-WebSocket-Version": "13",
                  "Sec-WebSocket-Key": "ZWRnZWZhbGwtcHJvYmUtMQ==",
                },
              },
              (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (chunk: string) => {
                  body += chunk;
                  if (body.length > 512) req.destroy(new Error("Unbounded admission response"));
                });
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
              },
            );
            req.on("upgrade", (_res, socket) => {
              socket.destroy();
              reject(new Error("Unauthorized socket admitted"));
            });
            req.on("error", reject);
            req.setTimeout(2000, () => req.destroy(new Error("Admission timeout")));
            req.end();
          });
        const missing = await denied(0, { "X-Edgefall-Profile": "forged-owner" });
        assert.equal(missing.status, 401);
        const foreignOrigin = await fetch(`${base}/profile`, {
          method: "POST",
          headers: { Origin: "https://example.com" },
        });
        assert.equal(foreignOrigin.status, 403);
        const stranger = await fetch(`${base}/profile`, { method: "POST" });
        const strangerCookie = stranger.headers.get("set-cookie")?.split(";")[0];
        assert(strangerCookie);
        const foreign = await denied(0, { Cookie: strangerCookie });
        assert.equal(foreign.status, 409);
        assert.equal(foreign.body, "in-progress");
        const owner = pages[0];
        assert(owner);
        const cookie = (await owner.context().cookies(base))
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        const wrongSlot = await denied(1, { Cookie: cookie });
        assert.equal(wrongSlot.status, 409);
        assert.equal(wrongSlot.body, "profile-slot-mismatch");
        const tampered = await denied(0, { Cookie: `${cookie}.extra` });
        assert.equal(tampered.status, 401);
        const replacement = await owner.context().newPage();
        await replacement.goto(`${owner.url()}&scripted=1`);
        pages[0] = replacement;
        await replacement.waitForFunction(() => {
          const state = (
            globalThis as unknown as { controllerNetworkLab?: { status: () => ClientStatus } }
          ).controllerNetworkLab?.status();
          return state?.ready || state?.error;
        });
        const installed = (await read())[0];
        assert(installed?.ready && !installed.error, JSON.stringify(installed));
        const afterTakeover = await waitTick(installed.initialServerTick + 30);
        const retired = await owner.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status: () => ClientStatus } }
          ).controllerNetworkLab.status(),
        );
        assert(retired.error?.includes("connection-replaced"));
        await owner.close();
        const takeoverRoom = await status();
        assert(takeoverRoom.staleSocketEvents > 0, "Old close must be fenced");
        const returning = afterTakeover[0];
        assert(returning && before[0]);
        assert.equal(returning.connectionEpoch, before[0].connectionEpoch + 1);
        assert.equal(returning.initialActor?.controlEpoch, before[0].authoritative?.controlEpoch);
        assert.equal(returning.initialActor?.lives, before[0].authoritative?.lives);
        assert.equal(returning.initialActor?.health, before[0].authoritative?.health);
        assert.equal(returning.receipts[0]?.ack, 0);
        assert(returning.baselineEventCursor > 0);
        assert.equal(returning.events?.counts.killed ?? 0, 0);
        assert(returning.events?.receipts.every((e) => e.cursor > returning.baselineEventCursor));
        for (const [slot, original] of before.entries()) {
          const current = afterTakeover[slot];
          assert(current);
          assert.equal(current.runEpoch, original.runEpoch);
          if (slot === 0) continue;
          assert.equal(current.connectionEpoch, original.connectionEpoch);
          assert(current.sequence > original.sequence);
          assert.deepEqual(
            current.events?.receipts.slice(0, original.events?.receipts.length),
            original.events?.receipts,
          );
        }
        // Leave the host disconnected long enough to observe succession, then reuse its cookie.
        const hostSlot = takeoverRoom.membership?.hostSlot;
        assert(hostSlot !== null && hostSlot !== undefined);
        const hostPage = pages[hostSlot];
        assert(hostPage);
        await hostPage.goto("about:blank");
        let disconnected = await status();
        for (let i = 0; i < 40 && disconnected.membership?.members[hostSlot]?.connected; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          disconnected = await status();
        }
        assert.equal(disconnected.membership?.members[hostSlot]?.connected, false);
        assert.notEqual(disconnected.membership?.hostSlot, hostSlot);
        await hostPage.goto(
          `http://127.0.0.1:${address.port}/network-lab.html?room=${encodeURIComponent(base)}&slot=${hostSlot}&mode=combat&scripted=1&manual=1`,
        );
        await hostPage.waitForFunction(
          () =>
            (
              globalThis as unknown as { controllerNetworkLab?: { status: () => ClientStatus } }
            ).controllerNetworkLab?.status().ready,
        );
        const rejoined = (await read())[hostSlot];
        assert(rejoined);
        const afterReentry = await waitTick(rejoined.initialServerTick + 30);
        assert.equal(
          afterReentry[hostSlot]?.connectionEpoch,
          (afterTakeover[hostSlot]?.connectionEpoch ?? 0) + 1,
        );
        assert.equal((await status()).membership?.hostSlot, disconnected.membership?.hostSlot);
        // An authenticated replacement still cannot submit gameplay before acknowledging welcome.
        const unacknowledged = encodeInputBatch({
          runEpoch: returning.runEpoch,
          connectionEpoch: (afterReentry[0]?.connectionEpoch ?? 0) + 1,
          packetSequence: 1,
          snapshotAck: 0,
          eventAck: 0,
          commands: [{ sequence: 1, clientTick: 0, controlEpoch: 1, held: 0, aim: 0, edges: [] }],
        });
        const rejected = await replacement.evaluate(
          ({ url, bytes }) =>
            new Promise<{ code: number; reason: string }>((resolve, reject) => {
              const socket = new WebSocket(url);
              socket.binaryType = "arraybuffer";
              const timeout = setTimeout(() => {
                socket.close();
                reject(new Error("Missing baseline rejection"));
              }, 2000);
              let sent = false;
              socket.onmessage = (event) => {
                if (!sent && event.data instanceof ArrayBuffer) {
                  sent = true;
                  socket.send(new Uint8Array(bytes));
                }
              };
              socket.onclose = (event) => {
                clearTimeout(timeout);
                resolve({ code: event.code, reason: event.reason });
              };
            }),
          {
            url: `${base.replace("http:", "ws:")}/combat/connect?slot=0`,
            bytes: [...unacknowledged],
          },
        );
        assert.equal(rejected.code, 4004);
        const rejectedRoom = await status();
        assert.equal(
          rejectedRoom.peers.find((p) => p.slot === 0)?.lastInputError,
          "Fresh baseline acknowledgment required",
        );
        assert.equal(
          rejectedRoom.inputStreams.find((s) => s.acknowledgment.playerId === 1)?.acknowledgment
            .lastProcessedSequence,
          0,
        );
        await replacement.reload();
        await replacement.waitForFunction(
          () =>
            (
              globalThis as unknown as { controllerNetworkLab?: { status: () => ClientStatus } }
            ).controllerNetworkLab?.status().ready,
        );
        const lastReentry = (await read())[0];
        assert(lastReentry);
        const clients = await waitTick(lastReentry.initialServerTick + 45);
        const finalRoom = await status();
        assert.equal(finalRoom.connections.length - beforeRoom.connections.length, 4);
        for (const [slot, original] of afterReentry.entries()) {
          if (slot === 0) continue;
          const continued = clients[slot];
          assert(continued);
          assert.equal(continued.connectionEpoch, original.connectionEpoch);
          assert(continued.sequence > original.sequence);
        }
        assert(finalRoom.peers.every((p) => p.active && !p.lastInputError && !p.lastOutputError));
        assert(finalRoom.inputStreams.every((s) => s.initialBaseline === null));
        assert.equal(
          finalRoom.combat?.world.encounter.kills.reduce((sum, k) => sum + k.count, 0),
          2,
        );
        assert.equal(clients[0]?.events?.counts.killed ?? 0, 0);
        assert(
          finalRoom.durability &&
            finalRoom.durability.committedTick >= lastReentry.initialServerTick,
        );
        const common =
          clients[0]?.receipts.filter((r) =>
            clients.every((c) => c.receipts.some((v) => v.tick === r.tick && v.hash === r.hash)),
          ) ?? [];
        assert(common.length >= 8, "Insufficient shared continuation snapshots");
        assert(
          clients.every((c) => c.receipts.every((r) => r.correctionX === 0 && r.correctionY === 0)),
        );
        // Fresh process reconstructs the latest checkpoint/journal prefix after the replacements.
        base = await restart();
        const recovered = await status();
        assert.equal(recovered.worldFailure, null);
        assert.equal(recovered.runEpoch, finalRoom.runEpoch + 1);
        assert(recovered.tick >= lastReentry.initialServerTick);
        const members = recovered.membership;
        assert(members);
        assert(members.members.every((m) => !m.connected));
        assert.equal(members.members[0]?.generation, finalRoom.membership?.members[0]?.generation);
        assert.equal(
          recovered.combat?.world.encounter.kills.reduce((sum, k) => sum + k.count, 0),
          2,
        );
        return {
          status: "pass",
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          recordedAt: new Date().toISOString(),
          browser: browser.version(),
          workerBundleSha256,
          sharedSnapshots: common.length,
          authorization: {
            missingProfile: missing.status,
            foreignOrigin: foreignOrigin.status,
            foreignProfile: foreign.status,
            wrongSlot: wrongSlot.status,
            tamperedProfile: tampered.status,
          },
          loading,
          phases,
          rejected,
          rejectedRoom,
          afterReentry,
          before,
          beforeRoom,
          afterTakeover,
          retired,
          takeoverRoom,
          disconnected,
          room: finalRoom,
          clients,
          recovered,
          scope:
            "Four real Chromium clients and local workerd: signed slot ownership, connected takeover, disconnected reentry, healthy peer continuity, fresh baseline acknowledgment, obsolete effect suppression, host succession and SQLite restart after journaled replacements. Optional lobby phase proof checks signed host commands and three epoch fences, waiting takeover, persisted empty lobby and same-document cold return. Optional loading proof checks saved connection replacement, discarded old preload and a fresh-input start barrier. No campaign continue/rematch, deployed traces, automatic retry, hostile reentry protection or completed production membership protocol.",
        };
      }
      if (combatRecoveryMode) {
        const status = async () => {
          const response = await fetch(`${base}/combat/status`);
          assert(response.ok, `Combat status: ${response.status}`);
          room = (await response.json()) as RoomProbeStatus;
          return room;
        };
        const waitForTick = async (tick: number) => {
          for (let attempt = 0; attempt < 120; attempt++) {
            const clients = await read();
            assert(
              clients.every((client) => !client.error && !client.requiresResync),
              JSON.stringify(
                clients.map((c) => ({ slot: c.slot, tick: c.snapshotTick, error: c.error })),
              ),
            );
            if (clients.every((client) => client.snapshotTick >= tick)) return clients;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error("Combat recovery progression timed out");
        };
        const reopen = async (boundary: RoomProbeStatus, old: ClientStatus[]) => {
          assert.equal(boundary.roomMode, "loading");
          assert.equal(boundary.clock.tick, boundary.tick);
          assert.equal(boundary.clock.timerPending, false);
          await Promise.all(
            pages.map(async (page, slot) => {
              await page.goto(
                `http://127.0.0.1:${address.port}/network-lab.html?room=${encodeURIComponent(base)}&slot=${slot}&mode=combat&manual=1`,
              );
              await page.waitForFunction(() => {
                const lab = (
                  globalThis as unknown as {
                    controllerNetworkLab?: { status: () => ClientStatus };
                  }
                ).controllerNetworkLab;
                return lab?.status().ready || lab?.status().error;
              });
              await page.locator("#scripted").check();
            }),
          );
          const baselines = await read();
          for (const client of baselines) {
            assert.equal(client.error, null);
            assert.equal(client.runEpoch, boundary.runEpoch);
            assert.equal(client.initialServerTick, boundary.tick);
            assert.equal(client.sequence, 0);
            assert.equal(client.pending, 0);
            assert.equal(client.events?.cursor, 0);
            assert.equal(client.events?.receipts.length, 0);
            assert.equal(
              client.authoritative?.controlEpoch,
              (old[client.slot]?.authoritative?.controlEpoch ?? 0) + 1,
            );
            assert.deepEqual(client.authoritative?.processedEdgeIds, [0, 0, 0, 0, 0]);
            const previous = old[client.slot]?.receipts.find(
              (receipt) => receipt.tick === boundary.tick,
            );
            assert(previous, `Missing prior public baseline at restored tick ${boundary.tick}`);
            assert.equal(
              client.receipts[0]?.continuationHash,
              previous.continuationHash,
              "Combat continuation changed at recovery boundary",
            );
            assert.equal(
              client.combatBaseline?.kills.find((kill) => kill.playerId === 2)?.count,
              2,
            );
          }
          const premature = await roomHostCommand(base, pages, "start");
          assert.equal(premature.status, 409, "Combat resumed without fresh preloaded input");
          await prepareAndStart();
          return baselines;
        };
        await waitForTick(90);
        const beforeRestart = await status();
        assert(beforeRestart.durability && beforeRestart.durability.committedTick >= 75);
        assert.equal(beforeRestart.clock.fault, null);
        assert.equal(beforeRestart.persistenceFailure, null);
        // Dispose the owned workerd process while its room is playing; create another process using
        // only the same SQLite directory. This is orderly process replacement, not power-loss proof.
        base = await restart();
        const boundary = await status();
        const retiredClients = await read(true);
        assert.notEqual(boundary.instanceId, beforeRestart.instanceId);
        assert.equal(boundary.runEpoch, beforeRestart.runEpoch + 1);
        assert(boundary.recoveryBoundary);
        assert.equal(boundary.recoveryBoundary.fromRunEpoch, beforeRestart.runEpoch);
        assert(boundary.tick >= beforeRestart.durability.committedTick);
        assert.equal(boundary.tick % 15, 0);
        assert(
          retiredClients.every(
            (client) => client.error?.includes("closed:") && client.inputClock?.mode === "closed",
          ),
          "Old process retained input capture",
        );
        const rewindTicks = retiredClients.map((client) =>
          Math.max(0, client.snapshotTick - boundary.tick),
        );
        const rewindLimit = beforeRestart.durability.limitTicks;
        assert(rewindTicks.every((ticks) => ticks <= rewindLimit));
        const baselines = await reopen(boundary, retiredClients);
        const continued = await waitForTick(boundary.tick + 45);
        assert(
          continued.every((client) => (client.events?.counts.killed ?? 0) === 0),
          "Recovery replayed old kill effects",
        );
        const armedResponse = await fetch(`${base}/combat/fail-next-write`, { method: "POST" });
        assert.equal(armedResponse.status, 200);
        const armed = await armedResponse.json();
        let paused = await status();
        for (let attempt = 0; attempt < 80 && !paused.persistenceFailure; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          paused = await status();
        }
        assert(
          paused.persistenceFailure?.includes("injected-combat-storage-failure"),
          "Write failure was not injected",
        );
        assert.equal(paused.roomMode, "recovering");
        assert.equal(paused.worldFailure, null);
        assert.equal(paused.clock.fault, null, "Accepted tick became a clock failure");
        assert.equal(paused.clock.tick, paused.tick);
        assert.equal(paused.clock.timerPending, false);
        assert(paused.durability);
        assert.equal(paused.durability.acceptedTick, paused.tick);
        assert(paused.durability.backlogTicks >= 15 && paused.durability.backlogTicks <= 30);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal((await status()).tick, paused.tick, "Room advanced after failed persistence");
        const failedClients = await read(true);
        assert(
          failedClients.every((client) => client.error?.includes("persistence-recovery")),
          "Failed writer retained old sockets",
        );
        const recover = await fetch(`${base}/combat/recover`, { method: "POST" });
        assert.equal(recover.status, 200);
        const failedBoundary = await status();
        assert.equal(failedBoundary.runEpoch, boundary.runEpoch + 1);
        assert.equal(failedBoundary.tick, paused.durability.committedTick);
        assert.equal(
          failedBoundary.recoveryBoundary?.restoredHash,
          paused.durability.committedHash,
        );
        const failureBaselines = await reopen(failedBoundary, failedClients);
        const afterFailure = await waitForTick(failedBoundary.tick + 30);
        const holdResponse = await fetch(`${base}/combat/hold-next-write`, { method: "POST" });
        assert.equal(holdResponse.status, 200);
        const hold = await holdResponse.json();
        let stalled = await status();
        for (let attempt = 0; attempt < 80 && !stalled.persistenceFailure; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          stalled = await status();
        }
        assert.equal(stalled.persistenceFailure, "journal-backlog-limit");
        assert.equal(stalled.persistenceHeld, true);
        assert.equal(stalled.roomMode, "recovering");
        assert.equal(stalled.worldFailure, null);
        assert.equal(stalled.clock.fault, null);
        assert.equal(stalled.clock.tick, stalled.tick);
        assert.equal(stalled.clock.timerPending, false);
        assert(stalled.durability);
        assert.equal(stalled.durability.backlogTicks, 30);
        assert.equal(stalled.durability.queuedTicks, 15);
        assert.equal(stalled.durability.writing, true);
        assert.equal(stalled.durability.acceptedTick, stalled.tick);
        const releasedResponse = await fetch(`${base}/combat/release-write`, { method: "POST" });
        assert.equal(releasedResponse.status, 200);
        let released = await status();
        for (let attempt = 0; attempt < 80 && released.durability?.writing; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          released = await status();
        }
        assert.equal(released.durability?.committedTick, stalled.durability.committedTick + 15);
        assert.equal(released.tick, stalled.tick, "Late confirmation resumed paused gameplay");
        assert.equal(released.roomMode, "recovering");
        assert.equal(released.durability?.accepting, false);
        assert.equal(released.durability?.writing, false);
        const stalledClients = await read(true);
        assert(stalledClients.every((client) => client.error?.includes("persistence-recovery")));
        const backlogRecover = await fetch(`${base}/combat/recover`, { method: "POST" });
        assert.equal(backlogRecover.status, 200);
        const backlogBoundary = await status();
        assert.equal(backlogBoundary.runEpoch, failedBoundary.runEpoch + 1);
        assert.equal(backlogBoundary.tick, released.durability?.committedTick);
        assert.equal(
          backlogBoundary.recoveryBoundary?.restoredHash,
          released.durability?.committedHash,
        );
        const backlogBaselines = await reopen(backlogBoundary, stalledClients);
        const clients = await waitForTick(backlogBoundary.tick + 30);
        room = await status();
        assert.equal(room.clock.fault, null);
        assert.equal(room.persistenceFailure, null);
        assert(room.durability && room.durability.committedTick >= backlogBoundary.tick + 15);
        assert(
          clients.every(
            (client) =>
              (client.events?.counts.killed ?? 0) === 0 &&
              client.combatBaseline?.kills.find((kill) => kill.playerId === 2)?.count === 2,
          ),
        );
        assert(
          [...continued, ...afterFailure, ...clients].every((client) =>
            client.receipts.every(
              (receipt) => receipt.correctionX === 0 && receipt.correctionY === 0,
            ),
          ),
          "Recovered movement diverged",
        );
        await pages[0]?.screenshot({ path: `${output}/four-player-controller.png` });
        return {
          status: "pass",
          recordedAt: new Date().toISOString(),
          baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          browser: browser.version(),
          bundleSha256: createHash("sha256")
            .update(await readFile(`${root}/network-lab.js`))
            .digest("hex"),
          workerBundleSha256,
          sharedSnapshots:
            clients[0]?.receipts.filter((receipt) =>
              clients.every((client) =>
                client.receipts.some(
                  (other) => other.tick === receipt.tick && other.hash === receipt.hash,
                ),
              ),
            ).length ?? 0,
          clients,
          room,
          restart: {
            before: beforeRestart,
            boundary,
            retiredClients,
            baselines,
            rewindTicks,
            continued,
          },
          writeFailure: {
            armed,
            paused,
            clients: failedClients,
            boundary: failedBoundary,
            baselines: failureBaselines,
            continued: afterFailure,
          },
          backlog: {
            hold,
            stalled,
            released,
            clients: stalledClients,
            boundary: backlogBoundary,
            baselines: backlogBaselines,
          },
          scope:
            "Four real browser WebSocket clients, fresh local workerd process/SQLite recovery, persisted epoch and fresh-input barriers, continued combat, injected transactional write failure and slow-write backlog pause; no power-loss, deployed durability, automatic reconnect or sustained timing acceptance",
        };
      }
      if (combatMode) {
        let clients: ClientStatus[] = [];
        const target = faultMode ? 12 : baselineMode ? 165 : 90;
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
          clients[baselineMode ? 1 : 0]?.events?.receipts.filter((item) =>
            clients
              .slice(baselineMode ? 1 : 0)
              .every((client) =>
                client.events?.receipts.some(
                  (other) => other.cursor === item.cursor && other.hash === item.hash,
                ),
              ),
          ).length ?? 0;
        if (!faultMode) {
          assert(
            clients.every(
              (client) =>
                client.combatBaseline?.phase === "complete" &&
                client.combatBaseline.kills.find((k) => k.playerId === 2)?.count === 2 &&
                client.combatBaseline.members.every((m) => m.status === "resolved"),
            ),
            "Combat baseline lost terminal accounting",
          );
          assert(sharedEvents >= 100, "Missing shared gameplay event prefix");
          assert(
            clients.every(
              (client, slot) =>
                (client.events?.counts.killed ?? 0) === (baselineMode && slot === 0 ? 0 : 2) &&
                !client.events?.requiresBaseline,
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
          if (!baselineMode) await configureEvents(0, { pauseUntilBaseline: true });
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
              (client, slot) =>
                (client.events?.counts.killed ?? 0) === (baselineMode && slot === 0 ? 0 : 2) &&
                !client.events?.requiresBaseline,
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
              (client, slot) =>
                (client.events?.counts.killed ?? 0) === (baselineMode && slot === 0 ? 0 : 2) &&
                !client.events?.requiresBaseline,
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
          missedKillBaseline: baselineMode,
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
          repeatNeutralization: {
            held: repeatInput.held,
            pendingEdges: repeatInput.pendingEdges,
          },
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
  };
  const report = await withDirectRoomWorker(runProbe, {
    combatScenario: rocketMode
      ? "rocket"
      : supportMode
        ? "support"
        : hmgMode
          ? "hmg"
          : ordnanceMode
            ? "ordnance"
            : tankMode
              ? "tank"
              : (areaMode ?? (shieldMode ? "guard" : hostileMode ? "rifle" : "range")),
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
