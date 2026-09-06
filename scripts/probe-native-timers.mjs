import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

// Use Wrangler's installed local runtime, without installing a second runtime or deploying.
const require = createRequire(import.meta.url);
const workerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire("miniflare");
assert(
  process.argv.length === 2 ||
    (process.argv.length === 3 && ["--wrangler", "--inspector"].includes(process.argv[2])),
  "Only a bounded local comparison is supported",
);
const runtimeMode =
  process.argv[2] === "--wrangler"
    ? "wrangler"
    : process.argv[2] === "--inspector"
      ? "direct-workerd-inspector"
      : "direct-workerd";
const script = `
import { DurableObject } from "cloudflare:workers";
export class NativeClockProbe extends DurableObject {
  sockets = []; samples = []; messages = 0; timer = null; watchdog = null;
  stop() {
    clearTimeout(this.timer); clearTimeout(this.watchdog);
    this.timer = null; this.watchdog = null;
  }
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/connect")) {
      if (this.sockets.length === 4) return new Response("Full", { status: 409 });
      const pair = new WebSocketPair();
      if (url.pathname.startsWith("/hibernation/")) this.ctx.acceptWebSocket(pair[1]);
      else { pair[1].accept(); pair[1].addEventListener("message", () => this.messages++); }
      this.sockets.push(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname.endsWith("/start")) {
      if (this.timer !== null || this.samples.length) return new Response("Already ran", { status: 409 });
      const schedule = () => {
        const at = performance.now();
        this.timer = setTimeout(() => {
          this.samples.push([at, performance.now(), this.messages]);
          if (this.samples.length < 60) schedule(); else this.stop();
        }, 1000 / 60);
      };
      this.watchdog = setTimeout(() => this.stop(), 1500);
      schedule();
    }
    if (url.pathname.endsWith("/stop")) this.stop();
    return Response.json({ samples: this.samples, messages: this.messages, active: this.timer !== null });
  }
  webSocketMessage() { this.messages++; }
  webSocketClose() {}
}
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/health") return Response.json({ fixture: "edgefall-native-timers" });
    const mode = new URL(request.url).pathname.split("/")[1];
    return env.PROBES.getByName(mode).fetch(request);
  }
};`;
const results = [];
async function run(base) {
  for (const mode of ["http", "classic", "hibernation"]) {
    const sockets = [];
    const observerClocks = [];
    const origin = performance.now();
    let interval;
    try {
      for (let slot = 0; slot < (mode === "http" ? 0 : 4); slot++) {
        const socket = new WebSocket(`${base.replace("http:", "ws:")}/${mode}/connect`);
        sockets.push(socket);
        await Promise.race([
          new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", reject, { once: true });
          }),
          delay(2000).then(() => {
            throw new Error("WebSocket startup timed out");
          }),
        ]);
      }
      const start = await fetch(`${base}/${mode}/start`, { signal: AbortSignal.timeout(2000) });
      assert(start.ok);
      interval = setInterval(() => {
        observerClocks.push([performance.now() - origin, Date.now()]);
        for (const socket of sockets)
          if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array(52));
      }, 1000 / 60);
      await delay(1600);
      const response = await fetch(`${base}/${mode}/stop`, { signal: AbortSignal.timeout(2000) });
      assert(response.ok);
      results.push({ mode, observerClocks, ...(await response.json()) });
    } finally {
      clearInterval(interval);
      for (const socket of sockets) socket.close();
    }
  }
}
if (runtimeMode === "wrangler") {
  const { withLocalWorker } = await import("./lib/local-worker.ts");
  await mkdir("dist/native-timers", { recursive: true });
  await writeFile("dist/native-timers/worker.mjs", script);
  await writeFile(
    "dist/native-timers/wrangler.jsonc",
    JSON.stringify({
      name: "edgefall-native-timers",
      main: "worker.mjs",
      compatibility_date: "2026-08-30",
      workers_dev: false,
      durable_objects: { bindings: [{ name: "PROBES", class_name: "NativeClockProbe" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["NativeClockProbe"] }],
    }),
  );
  await withLocalWorker(8793, "dist/native-timers/wrangler.jsonc", "edgefall-native-timers", run);
} else {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      inspectorPort: runtimeMode === "direct-workerd-inspector" ? 0 : undefined,
      modules: true,
      script,
      compatibilityDate: "2026-08-30",
      durableObjects: { PROBES: { className: "NativeClockProbe", useSQLite: true } },
      log: new Log(LogLevel.ERROR),
    }),
  );
  try {
    const url = await mf.ready;
    url.hostname = "127.0.0.1";
    await run(url.origin);
  } finally {
    await mf.dispose();
  }
}
const source = createHash("sha256");
for (const path of ["scripts/probe-native-timers.mjs", "scripts/lib/local-worker.ts"])
  source
    .update(path)
    .update("\0")
    .update(await readFile(path))
    .update("\0");
const report = {
  sourceSha256: source.digest("hex"),
  runtimeMode,
  recordedAt: new Date().toISOString(),
  node: process.version,
  wrangler: require("wrangler/package.json").version,
  workerd: workerRequire("workerd/package.json").version,
  scope:
    "Minimal local native timer comparison, without Edgefall scheduling, simulation, codecs or snapshot sends. Classic sockets are a diagnostic control, not the game architecture.",
  results,
};
await mkdir("dist/room-network-proof", { recursive: true });
await writeFile(
  `dist/room-network-proof/native-timers-${runtimeMode}.json`,
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify(
    results.map(({ mode, samples, messages, active }) => ({
      mode,
      callbacks: samples.length,
      messages,
      active,
      delaysMs: samples.map(([start, end]) => end - start),
    })),
  )}\n`,
);
