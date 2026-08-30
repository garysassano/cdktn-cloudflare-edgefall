import {
  type ClientMessage,
  type GameState,
  type InputFrame,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  RECONNECT_RESERVATION_SECONDS,
  type RunResult,
  type ServerMessage,
  TICK_SECONDS,
  isClientMessage,
} from "../game/protocol.js";
import {
  addPlayer,
  canStartRun,
  chooseReward,
  createCompactSnapshot,
  createGame,
  createRunResult,
  removeLobbyPlayer,
  resetToLobby,
  setPlayerConnected,
  setReady,
  startRun,
  stepGame,
  updateSelection,
} from "../game/simulation.js";

interface SocketAttachment {
  playerId?: string;
  profileId: string;
}

interface Reservation {
  expiresAt: number;
  playerId: string;
  profileId: string;
  token: string;
}

interface ReplayFrame {
  enemies: Array<[string, string, number, number, number]>;
  players: Array<[string, number, number, number, number]>;
  projectiles: Array<[string, number, number]>;
  tick: number;
}

const CHECKPOINT_KEY = "checkpoint-v2";
const RESERVATIONS_KEY = "reservations-v2";
const CHECKPOINT_TICKS = 30 * 30;

export class EdgefallRoom implements DurableObject {
  private game = createGame("pending");
  private inputs: Record<string, InputFrame> = {};
  private loopId: number | undefined;
  private recordedRunId = "";
  private replayFrames: ReplayFrame[] = [];
  private reservations: Reservation[] = [];

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      const [checkpoint, reservations] = await Promise.all([
        this.state.storage.get<GameState>(CHECKPOINT_KEY),
        this.state.storage.get<Reservation[]>(RESERVATIONS_KEY),
      ]);
      if (checkpoint) this.game = checkpoint;
      if (reservations) this.reservations = reservations;
      this.expireReservations();
      if (["combat", "reward", "boss"].includes(this.game.phase)) this.startLoop();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const roomCode = request.headers.get("X-Edgefall-Room") ?? "edgefall";
    if (this.game.roomCode === "pending") {
      this.game = createGame(roomCode, {
        daily: request.headers.get("X-Edgefall-Daily") === "1",
        seed: parseSeed(request.headers.get("X-Edgefall-Seed")),
      });
      await this.persistCheckpoint();
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({
        connectedPlayers: Object.values(this.game.players).filter((player) => player.connected)
          .length,
        phase: this.game.phase,
        roomCode: this.game.roomCode,
        tick: this.game.tick,
      });
    }

    const profileId = request.headers.get("X-Edgefall-Profile");
    if (!profileId) return new Response("Anonymous profile required", { status: 401 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ profileId } satisfies SocketAttachment);
    this.sendLobby(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, rawMessage: ArrayBuffer | string): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage),
      );
    } catch {
      this.sendError(socket, "invalid_json", "The room could not read that message.");
      return;
    }
    if (!isClientMessage(decoded)) {
      this.sendError(socket, "invalid_message", "Message does not match Edgefall protocol v2.");
      return;
    }

    const message: ClientMessage = decoded;
    if (message.type === "join") {
      this.join(socket, attachment, message.name);
      return;
    }
    if (message.type === "resume") {
      this.resume(socket, attachment, message.resumeToken);
      return;
    }
    if (!attachment.playerId) {
      this.sendError(
        socket,
        "session_required",
        "Join or resume the room before sending gameplay messages.",
      );
      return;
    }

    const playerId = attachment.playerId;
    if (message.type === "selection") updateSelection(this.game, playerId, message.selection);
    if (message.type === "ready") {
      setReady(this.game, playerId, message.ready);
      if (canStartRun(this.game)) {
        startRun(this.game, crypto.randomUUID());
        this.replayFrames = [];
        this.startLoop();
        this.state.waitUntil(this.persistCheckpoint());
      }
    }
    if (message.type === "input" && ["combat", "boss"].includes(this.game.phase)) {
      this.inputs[playerId] = message.input;
      return;
    }
    if (message.type === "upgrade-choice") chooseReward(this.game, playerId, message.choice);
    if (message.type === "rematch" && ["victory", "defeat"].includes(this.game.phase)) {
      resetToLobby(this.game);
      this.recordedRunId = "";
      this.state.waitUntil(this.persistCheckpoint());
    }
    this.broadcastState();
  }

  webSocketClose(socket: WebSocket): void {
    this.disconnect(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.disconnect(socket);
  }

  private join(socket: WebSocket, attachment: SocketAttachment, requestedName: string): void {
    this.expireReservations();
    if (attachment.playerId) {
      this.sendLobby(socket);
      return;
    }
    const existingReservation = this.reservations.find(
      (reservation) => reservation.profileId === attachment.profileId,
    );
    if (existingReservation && this.game.players[existingReservation.playerId]) {
      this.attachPlayer(socket, attachment, existingReservation);
      return;
    }
    if (this.game.phase !== "lobby") {
      this.sendError(
        socket,
        "run_locked",
        "This crew has already departed; reconnect with the reserved slot.",
      );
      return;
    }
    if (Object.keys(this.game.players).length >= MAX_PLAYERS) {
      this.sendError(socket, "room_full", "This private crew already has four operatives.");
      return;
    }
    const playerId = crypto.randomUUID();
    const player = addPlayer(this.game, playerId, requestedName);
    if (!player) {
      this.sendError(socket, "room_full", "No crew slot is available.");
      return;
    }
    const reservation: Reservation = {
      expiresAt: Date.now() + RECONNECT_RESERVATION_SECONDS * 1_000,
      playerId,
      profileId: attachment.profileId,
      token: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    };
    this.reservations.push(reservation);
    this.attachPlayer(socket, attachment, reservation);
    this.state.waitUntil(this.persistCheckpoint());
  }

  private resume(socket: WebSocket, attachment: SocketAttachment, resumeToken: string): void {
    this.expireReservations();
    const reservation = this.reservations.find(
      (candidate) =>
        candidate.token === resumeToken &&
        candidate.profileId === attachment.profileId &&
        (candidate.expiresAt === 0 || candidate.expiresAt > Date.now()),
    );
    if (!reservation || !this.game.players[reservation.playerId]) {
      this.sendError(socket, "resume_expired", "That reserved crew slot is no longer available.");
      return;
    }
    this.attachPlayer(socket, attachment, reservation);
  }

  private attachPlayer(
    socket: WebSocket,
    attachment: SocketAttachment,
    reservation: Reservation,
  ): void {
    for (const other of this.state.getWebSockets()) {
      if (other === socket) continue;
      const otherAttachment = other.deserializeAttachment() as SocketAttachment | null;
      if (otherAttachment?.playerId === reservation.playerId)
        other.close(1000, "Reconnected elsewhere");
    }
    attachment.playerId = reservation.playerId;
    reservation.expiresAt = 0;
    setPlayerConnected(this.game, reservation.playerId, true);
    socket.serializeAttachment(attachment);
    this.sendLobby(socket, reservation);
    this.sendCurrentState(socket, reservation.playerId);
    this.broadcastLobby();
    this.state.waitUntil(this.persistReservations());
  }

  private disconnect(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment?.playerId) return;
    const stillConnected = this.state.getWebSockets().some((other) => {
      if (other === socket) return false;
      const otherAttachment = other.deserializeAttachment() as SocketAttachment | null;
      return otherAttachment?.playerId === attachment.playerId;
    });
    if (stillConnected) return;
    delete this.inputs[attachment.playerId];
    setPlayerConnected(this.game, attachment.playerId, false);
    const reservation = this.reservations.find(
      (candidate) => candidate.playerId === attachment.playerId,
    );
    if (reservation) reservation.expiresAt = Date.now() + RECONNECT_RESERVATION_SECONDS * 1_000;
    this.broadcastLobby();
    this.state.waitUntil(this.persistCheckpoint());
  }

  private expireReservations(): void {
    const now = Date.now();
    const expired = this.reservations.filter(
      (reservation) => reservation.expiresAt > 0 && reservation.expiresAt <= now,
    );
    this.reservations = this.reservations.filter(
      (reservation) => reservation.expiresAt === 0 || reservation.expiresAt > now,
    );
    if (this.game.phase === "lobby") {
      for (const reservation of expired) {
        const player = this.game.players[reservation.playerId];
        if (player && !player.connected) removeLobbyPlayer(this.game, reservation.playerId);
      }
    }
  }

  private startLoop(): void {
    if (this.loopId !== undefined || !["combat", "reward", "boss"].includes(this.game.phase))
      return;
    this.loopId = setInterval(() => {
      const previousPhase = this.game.phase;
      const previousModule = this.game.moduleIndex;
      stepGame(this.game, this.inputs);
      if (this.game.tick % 10 === 0) this.captureReplayFrame();
      this.broadcastState();
      const crossedBoundary =
        previousPhase !== this.game.phase || previousModule !== this.game.moduleIndex;
      if (crossedBoundary || this.game.tick % CHECKPOINT_TICKS === 0) {
        this.state.waitUntil(this.persistCheckpoint());
      }
      if (["victory", "defeat"].includes(this.game.phase)) {
        this.stopLoop();
        if (this.recordedRunId !== this.game.runId) {
          this.recordedRunId = this.game.runId;
          this.state.waitUntil(this.recordCompletedRun());
        }
      }
    }, TICK_SECONDS * 1_000);
  }

  private stopLoop(): void {
    if (this.loopId === undefined) return;
    clearInterval(this.loopId);
    this.loopId = undefined;
  }

  private broadcastState(): void {
    if (this.game.phase === "lobby") {
      this.broadcastLobby();
      return;
    }
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment?.playerId) continue;
      this.sendCurrentState(socket, attachment.playerId);
    }
  }

  private sendCurrentState(socket: WebSocket, playerId: string): void {
    const player = this.game.players[playerId];
    if (!player) return;
    this.send(socket, {
      acknowledgedInput: player.acknowledgedInput,
      snapshot: createCompactSnapshot(this.game),
      type: "snapshot",
      v: PROTOCOL_VERSION,
    });
    if (this.game.events.length > 0) {
      this.send(socket, {
        events: this.game.events,
        tick: this.game.tick,
        type: "gameplay-events",
        v: PROTOCOL_VERSION,
      });
    }
    const offer = this.game.rewardOffers[playerId];
    if (this.game.phase === "reward" && offer && !offer.picked) {
      this.send(socket, { offer, type: "reward-choice", v: PROTOCOL_VERSION });
    }
    if (["victory", "defeat"].includes(this.game.phase)) {
      this.send(socket, {
        result: createRunResult(this.game),
        type: "results",
        v: PROTOCOL_VERSION,
      });
    }
  }

  private broadcastLobby(): void {
    for (const socket of this.state.getWebSockets()) this.sendLobby(socket);
  }

  private sendLobby(socket: WebSocket, knownReservation?: Reservation): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    const reservation =
      knownReservation ??
      this.reservations.find((candidate) => candidate.playerId === attachment?.playerId);
    this.send(socket, {
      locked: this.game.phase !== "lobby",
      players: Object.values(this.game.players)
        .sort((left, right) => left.slot - right.slot)
        .map((player) => ({
          connected: player.connected,
          id: player.id,
          name: player.name,
          ready: player.ready,
          selection: player.selection,
          slot: player.slot,
        })),
      resumeToken: reservation?.token,
      roomCode: this.game.roomCode,
      type: "lobby",
      v: PROTOCOL_VERSION,
      you: attachment?.playerId,
    });
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.send(socket, { code, message, type: "error", v: PROTOCOL_VERSION });
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      this.disconnect(socket);
    }
  }

  private captureReplayFrame(): void {
    this.replayFrames.push({
      enemies: this.game.enemies.map((enemy) => [
        enemy.id,
        enemy.kind,
        round(enemy.x),
        round(enemy.y),
        enemy.hp,
      ]),
      players: Object.values(this.game.players).map((player) => [
        player.id,
        round(player.x),
        round(player.y),
        player.hp,
        player.acknowledgedInput,
      ]),
      projectiles: this.game.projectiles.map((projectile) => [
        projectile.kind,
        round(projectile.x),
        round(projectile.y),
      ]),
      tick: this.game.tick,
    });
  }

  private async persistCheckpoint(): Promise<void> {
    await Promise.all([
      this.state.storage.put(CHECKPOINT_KEY, this.game),
      this.persistReservations(),
    ]);
  }

  private async persistReservations(): Promise<void> {
    await this.state.storage.put(RESERVATIONS_KEY, this.reservations);
  }

  private async recordCompletedRun(): Promise<void> {
    const result = createRunResult(this.game);
    const finishedAt = new Date().toISOString();
    const summary = { ...result, finishedAt, roomCode: this.game.roomCode };
    const replayLines = [
      JSON.stringify({ format: "edgefall-replay-v1", result, tickRate: 30 }),
      ...this.replayFrames.map((frame) => JSON.stringify(frame)),
    ].join("\n");
    await Promise.all([
      this.env.REPLAYS.put(`runs/${result.runId}.jsonl`, replayLines, {
        customMetadata: { result: result.result, seed: String(result.seed) },
        httpMetadata: { contentType: "application/x-ndjson" },
      }),
      this.recordRunMetadata(result, summary, finishedAt),
      this.persistCheckpoint(),
    ]);
  }

  private async recordRunMetadata(
    result: RunResult,
    summary: RunResult & { finishedAt: string; roomCode: string },
    finishedAt: string,
  ): Promise<void> {
    const statements = [
      this.env.RUNS.prepare(
        "INSERT OR REPLACE INTO runs (id, result, elapsed_ms, party_size, score, seed, daily, finished_at, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        result.runId,
        result.result,
        Math.round(result.elapsed * 1_000),
        result.party.length,
        result.score,
        result.seed,
        result.daily ? 1 : 0,
        finishedAt,
        JSON.stringify(summary),
      ),
    ];
    for (const player of Object.values(this.game.players)) {
      const profileId = this.reservations.find(
        (reservation) => reservation.playerId === player.id,
      )?.profileId;
      if (!profileId) continue;
      statements.push(
        this.env.RUNS.prepare(
          "INSERT OR IGNORE INTO run_players (run_id, profile_id, slot) VALUES (?, ?, ?)",
        ).bind(result.runId, profileId, player.slot),
      );
      if (result.result === "victory") {
        statements.push(
          this.env.RUNS.prepare(
            "INSERT OR IGNORE INTO unlocks (profile_id, unlock_id, unlocked_at) VALUES (?, 'kilnheart-clear', ?)",
          ).bind(profileId, finishedAt),
        );
      }
    }
    await this.env.RUNS.batch(statements);
  }
}

function parseSeed(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
