import { execFileSync } from "node:child_process";
import { type Page, expect, test } from "@playwright/test";
import type { CompactSnapshot, ServerMessage } from "../src/game/protocol.js";
import { addPlayer, createGame, createRunResult } from "../src/game/simulation.js";

function observe(page: Page) {
  const evidence = {
    playerId: "",
    snapshot: undefined as CompactSnapshot | undefined,
    sockets: 0,
    jumpCommands: 0,
  };
  page.on("websocket", (socket) => {
    evidence.sockets++;
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload)) as ServerMessage;
      if (message.type === "lobby" && message.you) evidence.playerId = message.you;
      if (message.type === "snapshot") evidence.snapshot = message.snapshot;
    });
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input" && message.input.jump) evidence.jumpCommands++;
    });
  });
  return evidence;
}

test("v2 real profile, two-player room, input, recording and reserved-slot reload", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const first = observe(page);
  const partnerContext = await browser.newContext({ baseURL: "http://127.0.0.1:8788" });
  const partner = await partnerContext.newPage();
  partner.on("pageerror", (error) => errors.push(error.message));
  const second = observe(partner);
  const room = `baseline-${Date.now().toString(36)}`;
  try {
    for (const [client, name] of [
      [page, "Baseline One"],
      [partner, "Baseline Two"],
    ] as const) {
      await client.goto("/");
      await client.locator("#playerName").fill(name);
      await client.locator("#roomCode").fill(room);
      await client.locator("#enterButton").click();
      await expect(client.locator("#lobby")).toBeVisible();
    }
    await expect.poll(() => first.playerId).not.toBe("");
    await expect.poll(() => second.playerId).not.toBe("");
    expect(first.playerId).not.toBe(second.playerId);
    const profile = await page.request.get("/api/profile");
    expect(profile.ok()).toBe(true);
    const profileId = (await profile.json()).id;
    await page.locator("#readyButton").click();
    await partner.locator("#readyButton").click();
    await expect.poll(() => first.snapshot?.phase).toBe("combat");
    await expect.poll(() => second.snapshot?.players.length).toBe(2);
    const playerId = first.playerId;
    const before = first.snapshot?.players.find((player) => player.id === playerId)?.x ?? 0;
    await page.locator("canvas").click();
    await page.keyboard.down("KeyD");
    await page.keyboard.down("Space");
    await page.mouse.down();
    await expect.poll(() => first.jumpCommands).toBeGreaterThan(0);
    await expect
      .poll(() => first.snapshot?.players.find((player) => player.id === playerId)?.x ?? 0)
      .toBeGreaterThan(before + 30);
    await page.keyboard.up("Space");
    await page.keyboard.up("KeyD");
    await page.mouse.up();
    // Measure ten short physical-event taps; v2's timer sampler can swallow them.
    const jumpsBeforeTaps = first.jumpCommands;
    for (let index = 0; index < 10; index++) {
      await page.keyboard.down("Space");
      await page.waitForTimeout(10);
      await page.keyboard.up("Space");
      await page.waitForTimeout(47);
    }
    const capturedTapCommands = first.jumpCommands - jumpsBeforeTaps;
    const tickBeforeReload = first.snapshot?.tick ?? 0;
    await page.reload();
    await page.locator("#enterButton").click();
    await expect.poll(() => first.sockets).toBe(2);
    await expect.poll(() => first.snapshot?.tick ?? 0).toBeGreaterThan(tickBeforeReload);
    expect(first.playerId).toBe(playerId);
    expect(first.snapshot?.players).toHaveLength(2);
    const resumedProfile = await page.request.get("/api/profile");
    expect((await resumedProfile.json()).id).toBe(profileId);
    await page.waitForTimeout(5000);
    expect(errors).toEqual([]);
    await testInfo.attach("sanitized-baseline-evidence", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify(
          {
            commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            browser: browser.version(),
            runtime: process.version,
            roomPlayers: 2,
            freshSockets: first.sockets,
            resumePreservedPlayer: first.playerId === playerId,
            tickBeforeReload,
            tickAfterReload: first.snapshot?.tick,
            shortTaps: 10,
            capturedTapCommands,
            impairment: "none; local workerd; SwiftShader rendering",
            errors,
          },
          null,
          2,
        ),
      ),
    });
  } finally {
    await testInfo.attach("browser-errors", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(errors)),
    });
    await partnerContext.close();
  }
});

test("v2 renders a persisted result and leaderboard from an explicitly seeded local fixture", async ({
  page,
}) => {
  const game = createGame("baseline-result", { seed: 47321 });
  addPlayer(game, "fixture", "Recorded fixture");
  game.runId = `baseline-result-${Date.now().toString(36)}`;
  game.phase = "victory";
  game.score = 1234;
  game.elapsed = 75;
  const result = createRunResult(game);
  const summary = JSON.stringify(result).replaceAll("'", "''");
  const sql = `INSERT INTO runs (id,result,elapsed_ms,party_size,score,seed,daily,finished_at,summary_json) VALUES ('${game.runId}','victory',75000,1,1234,47321,0,'2026-09-06T00:00:00Z','${summary}')`;
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "RUNS",
      "--local",
      "--persist-to",
      ".wrangler/e2e",
      "--command",
      sql,
    ],
    { stdio: "pipe" },
  );
  await page.goto(`/runs/${game.runId}`);
  await expect(page.locator("#results")).toBeVisible();
  await expect(page.locator("#resultScore")).toHaveText("001234");
  await expect(page.locator("#resultParty")).toContainText("Recorded fixture");
  await page.locator("#resultBoardsButton").click();
  await expect(page.locator(`a[href="/runs/${game.runId}"]`)).toBeVisible();
});
