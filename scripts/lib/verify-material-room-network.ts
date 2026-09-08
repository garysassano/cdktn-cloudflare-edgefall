import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { Page } from "@playwright/test";
import type { MaterialSurface } from "../../src/game/content/materials.js";
import {
  type MaterialLabDefinition,
  materialScenario,
} from "../../src/game/content/scenarios/materials.js";
import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { combatScenarioId } from "../../src/game/labs/combat-scenarios.js";
import { combatEndTerrain } from "../../src/game/labs/combat-terrain.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { EventEnvelope } from "../../src/shared/protocol/events.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface MaterialClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: FullSnapshot["players"][number];
  enemies: FullSnapshot["enemies"];
  props: NonNullable<FullSnapshot["combat"]>["props"];
  combatBaseline: NonNullable<FullSnapshot["combat"]>;
  renderedTerrain: Array<{
    tick: number;
    scenarioId: number;
    geometryRevision: number;
    surfaces: MaterialSurface[];
  }>;
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
  events: {
    counts: Record<string, number>;
    duplicates: number;
    framesDropped: number;
    receipts: Array<{ cursor: number; tick: number; hash: string }>;
  };
}

/** Keyboard intent crosses the real socket, admission, authoritative tick and acknowledged event path. */
export async function verifyMaterialRoomNetwork(
  pages: Page[],
  base: string,
  output: string,
  definition: MaterialLabDefinition,
) {
  const scenario = materialScenario(definition),
    scenarioId = combatScenarioId(scenario),
    history = new Map<number, EventEnvelope>(),
    samples: RoomProbeStatus["combat"][] = [];
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as {
              controllerNetworkLab: { status(include: boolean): MaterialClient };
            }
          ).controllerNetworkLab.status(true),
        ),
      ),
    );
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const response = await fetch(`${base}/combat/status`);
      assert(response.ok);
      const state = (await response.json()) as RoomProbeStatus;
      assert(
        !state.clock.fault && !state.worldFailure && !state.persistenceFailure,
        "Material room failed",
      );
      assert.equal(state.combat?.world.scenario, scenario);
      assert.equal(state.combat?.world.players.length, definition.players);
      for (const event of state.combat?.events ?? []) history.set(event.cursor, event);
      if (samples.at(-1)?.world.tick !== state.tick) samples.push(state.combat);
      assert(samples.length <= 1000, "Unbounded material observation");
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Material room boundary timed out: ${scenario}`);
  };
  if (definition.players === 1) {
    const rejection = await pages[0]?.evaluate(async (base) => {
      const response = await fetch(`${base}/combat/admission?slot=1`, { credentials: "include" });
      return { status: response.status, body: (await response.json()) as { code: string } };
    }, base);
    assert.equal(rejection?.status, 409, "Solo material room admitted an absent slot");
    assert.equal(rejection?.body.code, "room-full");
    const cookies = await pages[0]?.context().cookies(base);
    const upgradeStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${base}/combat/connect?slot=1`, {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"),
          Cookie: cookies?.map(({ name, value }) => `${name}=${value}`).join("; ") ?? "",
        },
      });
      request.once("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(upgradeStatus, 409, "Direct upgrade bypassed the material roster");
  }
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
      await page.locator("#game").focus();
      await page.evaluate(() =>
        (
          globalThis as unknown as {
            controllerNetworkLab: {
              configureEvents(value: { duplicate: boolean; dropNext: number }): void;
            };
          }
        ).controllerNetworkLab.configureEvents({ duplicate: true, dropNext: 4 }),
      );
    }),
  );
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() =>
        (
          globalThis as unknown as {
            controllerNetworkLab: { status(include: boolean): MaterialClient };
          }
        ).controllerNetworkLab
          .status(false)
          .renderedTerrain.some((drawn) => drawn.surfaces.some((surface) => surface.id === 200)),
      ),
    ),
  );
  const initial = await read();
  for (const client of initial) {
    assert.equal(client.combatBaseline.scenarioId, scenarioId);
    const drawn = client.renderedTerrain.at(-1);
    assert(drawn);
    assert.equal(
      canonical(drawn.surfaces),
      canonical(combatEndTerrain(scenario, drawn.tick, client.props)),
    );
  }
  await pages[0]?.screenshot({ path: `${output}/material-before.png` });
  await Promise.all(
    pages.map(async (page) => {
      if (definition.weapon === "grenade") await page.keyboard.down("ArrowDown");
      await page.keyboard.press(definition.weapon === "grenade" ? "KeyC" : "KeyZ", { delay: 10 });
    }),
  );
  await until(
    (state) =>
      state.inputStreams.length === definition.players &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const first = await until(
    (state) =>
      (state.combat?.world.players.every((player) =>
        definition.weapon === "grenade"
          ? player.grenadeStock === 9
          : definition.weapon === "knife"
            ? player.action.actionInstanceId > 0
            : player.weapon.shotOrdinal === 1,
      ) ??
        false) &&
      state.tick >= 12,
  );
  const final = await until((state) => state.tick >= 170),
    clients = await read(),
    accepted = final.combat?.world;
  assert(accepted);
  const ammo = {
    sidearm: 0,
    "heavy-machine-gun": 149,
    shotgun: 23,
    "rocket-launcher": 19,
    flamethrower: 29,
    laser: 119,
    knife: 0,
    grenade: 0,
  };
  for (const actor of accepted.players) {
    assert.equal(actor.weapon.ammo, ammo[definition.weapon]);
    assert.equal(
      actor.weapon.shotOrdinal,
      definition.weapon === "knife" || definition.weapon === "grenade" ? 0 : 1,
    );
    assert.equal(actor.grenadeStock, definition.weapon === "grenade" ? 9 : 10);
    assert.equal(actor.lives, 3);
  }
  const events = [...history.values()].sort((a, b) => a.cursor - b.cursor),
    eventHashes = new Map<number, string>();
  let eventHash = "0";
  for (const [index, event] of events.entries()) {
    assert.equal(event.cursor, index + 1, "Missing material event prefix");
    eventHash = stateHash([eventHash, { runEpoch: final.runEpoch, ...event }]);
    eventHashes.set(event.cursor, eventHash);
  }
  assert(events.length > 0);
  for (const [slot, client] of clients.entries()) {
    assert(client.ready && !client.error && !client.requiresResync);
    assert.equal(client.combatBaseline.scenarioId, scenarioId);
    assert.deepEqual(client.props, accepted.props);
    assert.deepEqual(client.authoritative.weapon, accepted.players[slot]?.weapon);
    assert.equal(client.events.framesDropped, 4);
    assert(client.events.duplicates > 0);
    assert.equal(client.events.receipts.length, events.length);
    assert.equal(
      new Set(client.events.receipts.map((receipt) => receipt.cursor)).size,
      events.length,
    );
    for (const receipt of client.events.receipts)
      assert.equal(receipt.hash, eventHashes.get(receipt.cursor));
    const drawn = client.renderedTerrain.at(-1);
    assert(drawn && drawn.tick >= 150);
    assert.equal(drawn.scenarioId, scenarioId);
    assert.equal(
      canonical(drawn.surfaces),
      canonical(combatEndTerrain(scenario, drawn.tick, accepted.props)),
    );
  }
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick >= 123 &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared terminal material snapshots");
  await pages[0]?.screenshot({ path: `${output}/material-after.png` });
  return {
    definition,
    scenario,
    scenarioId,
    first,
    initial,
    final,
    clients,
    common,
    events,
    eventHash,
    samples,
  };
}
