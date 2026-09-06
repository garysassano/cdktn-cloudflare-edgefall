import { dailyDateFromRoom } from "../game/daily.js";
import { dailySeed } from "../game/simulation.js";
import { EdgefallRoom } from "./room.js";

export { EdgefallRoom };

const PROFILE_COOKIE = "edgefall_profile";
const PROFILE_MAX_AGE = 60 * 60 * 24 * 365;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

interface BrowserProfile {
  id: string;
  setCookie?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json(
        { protocol: 2, status: "ok", tickRate: 30 },
        { headers: NO_STORE_HEADERS },
      );
    }
    if (url.pathname === "/api/profile") return profileResponse(request, env);
    if (url.pathname === "/api/leaderboards") return leaderboards(url, env.RUNS);

    const apiRunMatch = url.pathname.match(/^\/api\/runs\/([a-z0-9-]{8,80})$/i);
    if (apiRunMatch?.[1]) return runJson(apiRunMatch[1], env.RUNS);
    const resultPageMatch = url.pathname.match(/^\/runs\/([a-z0-9-]{8,80})$/i);
    if (resultPageMatch) return applicationShell(request, env.ASSETS);

    const roomMatch = url.pathname.match(/^\/rooms\/([a-z0-9-]{3,24})$/i);
    if (roomMatch?.[1]) return roomRequest(request, env, roomMatch[1].toLowerCase());

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function roomRequest(request: Request, env: Env, roomCode: string): Promise<Response> {
  const profile = await readProfile(request, env);
  if (!profile) {
    return Response.json(
      { code: "profile_required", message: "Create an anonymous browser profile before joining." },
      { headers: NO_STORE_HEADERS, status: 401 },
    );
  }
  const roomId = env.GAME_ROOMS.idFromName(roomCode);
  const forwarded = new Request(request);
  forwarded.headers.set("X-Edgefall-Profile", profile.id);
  forwarded.headers.set("X-Edgefall-Room", roomCode);
  const dailyDate = dailyDateFromRoom(roomCode);
  if (dailyDate) {
    forwarded.headers.set("X-Edgefall-Daily", "1");
    forwarded.headers.set("X-Edgefall-Seed", String(dailySeed(dailyDate)));
  }
  return env.GAME_ROOMS.get(roomId).fetch(forwarded);
}

async function profileResponse(request: Request, env: Env): Promise<Response> {
  const profile = await getOrCreateProfile(request, env);
  const [history, unlocks] = await Promise.all([
    env.RUNS.prepare(
      "SELECT r.id, r.result, r.elapsed_ms AS elapsedMs, r.party_size AS partySize, r.score, r.daily, r.finished_at AS finishedAt FROM runs r JOIN run_players rp ON rp.run_id = r.id WHERE rp.profile_id = ? ORDER BY r.finished_at DESC LIMIT 8",
    )
      .bind(profile.id)
      .all(),
    env.RUNS.prepare(
      "SELECT unlock_id AS unlockId, unlocked_at AS unlockedAt FROM unlocks WHERE profile_id = ? ORDER BY unlocked_at ASC",
    )
      .bind(profile.id)
      .all(),
  ]);
  const headers = new Headers(NO_STORE_HEADERS);
  if (profile.setCookie) headers.set("Set-Cookie", profile.setCookie);
  return Response.json(
    { id: profile.id, recentRuns: history.results, unlocks: unlocks.results },
    { headers },
  );
}

async function leaderboards(url: URL, database: D1Database): Promise<Response> {
  const partySize = Number.parseInt(url.searchParams.get("party") ?? "1", 10);
  const mode = url.searchParams.get("mode") === "daily" ? "daily" : "normal";
  if (partySize < 1 || partySize > 4) {
    return Response.json(
      { code: "invalid_party_size" },
      { headers: NO_STORE_HEADERS, status: 400 },
    );
  }
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const seed = dailySeed(date);
  const statement =
    mode === "daily"
      ? database
          .prepare(
            "SELECT id, elapsed_ms AS elapsedMs, party_size AS partySize, score, seed, finished_at AS finishedAt, summary_json AS summaryJson FROM runs WHERE result = 'victory' AND daily = 1 AND seed = ? AND party_size = ? ORDER BY score DESC, elapsed_ms ASC LIMIT 20",
          )
          .bind(seed, partySize)
      : database
          .prepare(
            "SELECT id, elapsed_ms AS elapsedMs, party_size AS partySize, score, seed, finished_at AS finishedAt, summary_json AS summaryJson FROM runs WHERE result = 'victory' AND daily = 0 AND party_size = ? ORDER BY score DESC, elapsed_ms ASC LIMIT 20",
          )
          .bind(partySize);
  const { results } = await statement.all();
  return Response.json(
    { date, mode, partySize, runs: results, seed },
    { headers: NO_STORE_HEADERS },
  );
}

async function runJson(runId: string, database: D1Database): Promise<Response> {
  const run = await database
    .prepare("SELECT summary_json AS summaryJson FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ summaryJson: string }>();
  if (!run)
    return Response.json({ code: "run_not_found" }, { headers: NO_STORE_HEADERS, status: 404 });
  try {
    return Response.json(JSON.parse(run.summaryJson), { headers: NO_STORE_HEADERS });
  } catch {
    return Response.json(
      { code: "invalid_run_record" },
      { headers: NO_STORE_HEADERS, status: 500 },
    );
  }
}

function applicationShell(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  // Static Assets canonicalizes /index.html to / with a redirect, which would
  // discard the browser's /runs/:id route. Fetch the canonical shell internally.
  url.pathname = "/";
  return assets.fetch(new Request(url, request));
}

async function getOrCreateProfile(request: Request, env: Env): Promise<BrowserProfile> {
  const existing = await readProfile(request, env);
  const now = new Date().toISOString();
  if (existing) {
    await env.RUNS.prepare("UPDATE profiles SET last_seen_at = ? WHERE id = ?")
      .bind(now, existing.id)
      .run();
    return existing;
  }
  const id = crypto.randomUUID();
  await env.RUNS.prepare("INSERT INTO profiles (id, created_at, last_seen_at) VALUES (?, ?, ?)")
    .bind(id, now, now)
    .run();
  const expires = Math.floor(Date.now() / 1_000) + PROFILE_MAX_AGE;
  const signature = await signProfile(`${id}.${expires}`, env.PROFILE_COOKIE_SECRET);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    id,
    setCookie: `${PROFILE_COOKIE}=${id}.${expires}.${signature}; Path=/; Max-Age=${PROFILE_MAX_AGE}; HttpOnly; SameSite=Strict${secure}`,
  };
}

async function readProfile(request: Request, env: Env): Promise<BrowserProfile | undefined> {
  const cookie = parseCookies(request.headers.get("Cookie"))[PROFILE_COOKIE];
  if (!cookie) return undefined;
  const [id, expiresText, signature] = cookie.split(".");
  const expires = Number.parseInt(expiresText ?? "", 10);
  if (!id || !signature || !Number.isSafeInteger(expires) || expires <= Date.now() / 1_000)
    return undefined;
  const expected = await signProfile(`${id}.${expires}`, env.PROFILE_COOKIE_SECRET);
  if (!constantTimeEqual(signature, expected)) return undefined;
  const found = await env.RUNS.prepare("SELECT id FROM profiles WHERE id = ?").bind(id).first();
  return found ? { id } : undefined;
}

async function signProfile(payload: string, secret: string): Promise<string> {
  if (secret.length < 32)
    throw new Error("PROFILE_COOKIE_SECRET must contain at least 32 characters");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}
