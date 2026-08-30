import favicon from "../client/favicon.svg";
import indexHtml from "../client/index.html";
import styles from "../client/styles.css";
import clientScript from "../generated/client.txt";
import { EdgefallRoom, ensureRunsTable } from "./room.js";

export { EdgefallRoom };

const STATIC_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, {
        headers: { ...STATIC_HEADERS, "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/client.js") {
      return new Response(clientScript, {
        headers: { ...STATIC_HEADERS, "Content-Type": "text/javascript; charset=utf-8" },
      });
    }
    if (url.pathname === "/favicon.svg") {
      return new Response(favicon, {
        headers: { ...STATIC_HEADERS, "Content-Type": "image/svg+xml" },
      });
    }
    if (url.pathname === "/styles.css") {
      return new Response(styles, {
        headers: { ...STATIC_HEADERS, "Content-Type": "text/css; charset=utf-8" },
      });
    }
    if (url.pathname === "/health") return Response.json({ status: "ok" });
    if (url.pathname === "/api/leaderboard") return leaderboard(env.RUNS);

    const roomMatch = url.pathname.match(/^\/rooms\/([a-z0-9-]{3,24})$/i);
    if (roomMatch) {
      const roomCode = roomMatch[1]?.toLowerCase();
      if (!roomCode) return new Response("Invalid room", { status: 400 });
      const roomId = env.GAME_ROOMS.idFromName(roomCode);
      const forwarded = new Request(request);
      forwarded.headers.set("X-Edgefall-Room", roomCode);
      return env.GAME_ROOMS.get(roomId).fetch(forwarded);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function leaderboard(database: D1Database): Promise<Response> {
  await ensureRunsTable(database);
  const { results } = await database
    .prepare(
      "SELECT id, room_code AS roomCode, result, elapsed, party_size AS partySize, finished_at AS finishedAt FROM runs WHERE result = 'victory' ORDER BY elapsed ASC LIMIT 10",
    )
    .all();
  return Response.json({ runs: results }, { headers: { "Cache-Control": "no-store" } });
}
