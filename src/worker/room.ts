import {
  type ClientMessage,
  type GameState,
  type ServerMessage,
  TICK_SECONDS,
  isClientMessage,
  isUpgradeId,
} from "../game/protocol.js";
import {
  addPlayer,
  chooseUpgrade,
  createGame,
  removePlayer,
  startRun,
  stepGame,
} from "../game/simulation.js";

interface SocketAttachment {
  playerId: string;
}

const MAX_PLAYERS = 4;
const SNAPSHOT_KEY = "game";

export class EdgefallRoom implements DurableObject {
  private game = createGame("pending");
  private inputs: Record<string, import("../game/protocol.js").InputFrame> = {};
  private loopId: number | undefined;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<GameState>(SNAPSHOT_KEY);
      if (stored) this.game = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ room: this.game.roomCode, state: this.game });
    }

    if (this.state.getWebSockets().length >= MAX_PLAYERS) {
      return new Response("This rift party is full", { status: 409 });
    }

    const roomCode = request.headers.get("X-Edgefall-Room") ?? "rift";
    if (this.game.roomCode === "pending") this.game = createGame(roomCode);

    const name = new URL(request.url).searchParams.get("name") ?? "";
    const playerId = crypto.randomUUID();
    addPlayer(this.game, playerId, name);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ playerId } satisfies SocketAttachment);
    server.send(
      JSON.stringify({
        type: "welcome",
        playerId,
        roomCode: this.game.roomCode,
      } satisfies ServerMessage),
    );

    this.startLoop();
    await this.persist();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, rawMessage: ArrayBuffer | string): void {
    this.startLoop();
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;

    let decoded: unknown;
    try {
      decoded = JSON.parse(
        typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage),
      );
    } catch {
      this.send(socket, { type: "error", message: "Invalid message" });
      return;
    }
    if (!isClientMessage(decoded)) {
      this.send(socket, { type: "error", message: "Invalid message" });
      return;
    }
    const message: ClientMessage = decoded;

    if (message.type === "input") {
      this.inputs[attachment.playerId] = message.input;
      return;
    }
    if (message.type === "start" && this.game.phase === "lobby") startRun(this.game);
    if (message.type === "restart" && ["victory", "defeat"].includes(this.game.phase)) {
      startRun(this.game);
    }
    if (message.type === "choose" && isUpgradeId(message.upgrade)) {
      chooseUpgrade(this.game, attachment.playerId, message.upgrade);
    }
    this.broadcast();
  }

  webSocketClose(socket: WebSocket): void {
    this.disconnect(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.disconnect(socket);
  }

  private disconnect(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    delete this.inputs[attachment.playerId];
    removePlayer(this.game, attachment.playerId);
    if (this.state.getWebSockets().length <= 1 && this.loopId !== undefined) {
      clearInterval(this.loopId);
      this.loopId = undefined;
    }
    this.state.waitUntil(this.persist());
    this.broadcast();
  }

  private startLoop(): void {
    if (this.loopId !== undefined) return;
    this.loopId = setInterval(() => {
      const previousPhase = this.game.phase;
      stepGame(this.game, this.inputs);
      this.broadcast();
      if (this.game.tick % 20 === 0) this.state.waitUntil(this.persist());
      if (
        previousPhase !== this.game.phase &&
        (this.game.phase === "victory" || this.game.phase === "defeat")
      ) {
        this.state.waitUntil(this.recordCompletedRun());
      }
    }, TICK_SECONDS * 1000);
  }

  private broadcast(): void {
    const encoded = JSON.stringify({ type: "snapshot", state: this.game } satisfies ServerMessage);
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(encoded);
      } catch {
        this.disconnect(socket);
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(SNAPSHOT_KEY, this.game);
  }

  private async recordCompletedRun(): Promise<void> {
    const result = this.game.phase;
    const partySize = Object.keys(this.game.players).length;
    const summary = {
      elapsed: this.game.elapsed,
      finishedAt: new Date().toISOString(),
      partySize,
      players: Object.values(this.game.players).map((player) => ({
        kills: player.kills,
        name: player.name,
        upgrades: player.upgrades,
      })),
      result,
      roomCode: this.game.roomCode,
      runId: this.game.runId,
    };

    await Promise.all([
      this.env.REPLAYS.put(`runs/${this.game.runId}.json`, JSON.stringify(summary), {
        httpMetadata: { contentType: "application/json" },
      }),
      ensureRunsTable(this.env.RUNS).then(() =>
        this.env.RUNS.prepare(
          "INSERT OR REPLACE INTO runs (id, room_code, result, elapsed, party_size, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
          .bind(
            this.game.runId,
            this.game.roomCode,
            result,
            Math.round(this.game.elapsed * 1000),
            partySize,
            summary.finishedAt,
          )
          .run(),
      ),
      this.persist(),
    ]);
  }
}

export async function ensureRunsTable(database: D1Database): Promise<void> {
  await database
    .prepare(
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, room_code TEXT NOT NULL, result TEXT NOT NULL, elapsed INTEGER NOT NULL, party_size INTEGER NOT NULL, finished_at TEXT NOT NULL)",
    )
    .run();
}
