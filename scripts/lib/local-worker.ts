import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import type { CombatScenario } from "../../src/game/labs/combat-scenarios.js";

/** A/B control that removes Wrangler's local proxy, using the exact same installed workerd. */
export async function withDirectRoomWorker<T>(
  run: (
    base: string,
    assertAlive: () => void,
    workerBundleSha256: string,
    restart: () => Promise<string>,
  ) => Promise<T>,
  options: {
    combatScenario?: CombatScenario;
    combatPlayers?: number;
  } = {},
): Promise<T> {
  const require = createRequire(import.meta.url);
  const workerRequire = createRequire(require.resolve("wrangler/package.json"));
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire("miniflare");
  const bundle = await build({
    entryPoints: ["src/worker/diagnostics/room-probe.ts"],
    bundle: true,
    external: ["cloudflare:workers"],
    platform: "neutral",
    format: "esm",
    write: false,
  });
  const directory = await mkdtemp(join(tmpdir(), "edgefall-room-worker-"));
  const profileSecret = randomBytes(32).toString("hex");
  let port: number | undefined;
  const create = () =>
    new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        port,
        script: bundle.outputFiles[0]?.text,
        compatibilityDate: "2026-08-30",
        bindings: {
          PROFILE_COOKIE_SECRET: profileSecret,
          PROBE_COMBAT_SCENARIO: options.combatScenario ?? "range",
          PROBE_COMBAT_PLAYERS: String(options.combatPlayers ?? 4),
        },
        durableObjects: { ROOM_PROBES: { className: "RoomLoadProbe", useSQLite: true } },
        resourcePersistencePath: directory,
        log: new Log(LogLevel.ERROR),
      }),
    );
  let mf = create();
  const origin = async () => {
    const url: URL = await mf.ready;
    port = Number(url.port);
    url.hostname = "127.0.0.1";
    return url.origin;
  };
  try {
    return await run(
      await origin(),
      () => {},
      createHash("sha256")
        .update(bundle.outputFiles[0]?.text ?? "")
        .digest("hex"),
      async () => {
        await mf.dispose();
        mf = create();
        return origin();
      },
    );
  } finally {
    try {
      await mf.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** Own a loopback workerd process. Never reuse a pre-existing listener or accept a remote URL. */
export async function withLocalWorker<T>(
  port: number,
  config: string,
  fixture: string,
  run: (base: string, assertAlive: () => void) => Promise<T>,
): Promise<T> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const base = `http://127.0.0.1:${port}`;
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
      config,
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let terminal = false;
  let log = "";
  const exited = new Promise<void>((resolve) => {
    server.once("error", () => {
      terminal = true;
      resolve();
    });
    server.once("exit", () => {
      terminal = true;
      resolve();
    });
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-16_384);
    });
  const assertAlive = () => assert(!terminal, `Owned local workerd exited: ${log}`);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assertAlive();
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
        ready = response.ok && ((await response.json()) as { fixture: string }).fixture === fixture;
      } catch {
        /* Bounded startup polling. */
      }
      if (ready) break;
      await delay(200);
    }
    assert(ready, `Local workerd did not become ready: ${log}`);
    return await run(base, assertAlive);
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
}
