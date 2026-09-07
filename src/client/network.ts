import {
  type ClientMessage,
  type CompactSnapshot,
  type GameplayEvent,
  type InputFrame,
  PROTOCOL_VERSION,
  type RewardOffer,
  type RunResult,
  type ServerMessage,
} from "../game/protocol.js";

import {
  type ConnectionPort,
  type ConnectionStatus,
  RoomConnectError,
  RoomSocketConnection,
} from "../shared/session/connection.js";

export interface ConnectionHandlers {
  events: (events: GameplayEvent[]) => void;
  lobby: (message: Extract<ServerMessage, { type: "lobby" }>) => void;
  result: (result: RunResult) => void;
  reward: (offer: RewardOffer) => void;
  snapshot: (snapshot: CompactSnapshot, playerId: string, pending: readonly InputFrame[]) => void;
  status: (status: ConnectionStatus) => void;
  warning: (message: string) => void;
}

export class RoomConnection {
  private pending: InputFrame[] = [];
  private playerId = "";
  private session: RoomSocketConnection | null = null;

  constructor(
    private readonly handlers: ConnectionHandlers,
    private readonly port: ConnectionPort,
    private readonly origin: string,
  ) {}

  connect(room: string, name: string): void {
    this.session?.leave();
    this.playerId = "";
    this.pending = [];
    let profileReady = false;
    let joined = false;
    const endpoint = new URL(`/rooms/${encodeURIComponent(room)}`, this.origin);
    if (!["https:", "http:"].includes(endpoint.protocol)) throw new Error("Invalid room origin");
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const url = endpoint.href;
    const session = new RoomSocketConnection({
      port: this.port,
      prepare: async (signal) => {
        if (!profileReady) {
          const response = await fetch("/api/profile", { credentials: "same-origin", signal });
          if (!response.ok)
            throw new RoomConnectError(
              response.status === 401 || response.status === 403 ? "profile-required" : "outage",
            );
          profileReady = true;
        }
        return url;
      },
      opened: () => {
        const resumeToken = localStorage.getItem(resumeKey(room));
        if (resumeToken)
          session.send(JSON.stringify({ resumeToken, type: "resume", v: PROTOCOL_VERSION }));
        else if (joined) session.stop("reservation-expired");
        else session.send(JSON.stringify({ name, type: "join", v: PROTOCOL_VERSION }));
      },
      suspended: () => {
        this.pending = [];
        this.playerId = "";
      },
      status: (state) => this.handlers.status(state),
      classifyClose: (code, reason) =>
        reason === "Reconnected elsewhere" ? "replaced" : code === 1000 ? "room-ended" : "outage",
      message: (data, generation) => {
        if (typeof data !== "string" || data.length > 256 * 1024) {
          session.stop("protocol-error");
          return;
        }
        let message: ServerMessage;
        try {
          message = JSON.parse(data) as ServerMessage;
        } catch {
          session.stop("protocol-error");
          return;
        }
        if (!message || typeof message !== "object") {
          session.stop("protocol-error");
          return;
        }
        if (message.v !== PROTOCOL_VERSION) {
          session.stop("incompatible-build");
          return;
        }
        if (message.type === "error") {
          if (message.code === "resume_expired") {
            localStorage.removeItem(resumeKey(room));
            session.stop("reservation-expired");
          } else if (message.code === "room_full") session.stop("room-full");
          else if (message.code === "in_progress") session.stop("in-progress");
          else this.handlers.warning(message.message);
          return;
        }
        if (message.type === "lobby") {
          if (message.you) {
            this.playerId = message.you;
            if (message.resumeToken) localStorage.setItem(resumeKey(room), message.resumeToken);
            joined = true;
            if (session.status.phase === "awaiting-baseline" && !session.ready(generation)) return;
          }
          this.handlers.lobby(message);
          return;
        }
        // The v2 room can broadcast between upgrade and resume. Never apply that pre-membership output.
        if (!this.playerId || session.status.phase !== "connected") return;
        if (message.type === "snapshot") {
          this.pending = this.pending.filter((input) => input.sequence > message.acknowledgedInput);
          this.handlers.snapshot(message.snapshot, this.playerId, this.pending);
        } else if (message.type === "gameplay-events") this.handlers.events(message.events);
        else if (message.type === "reward-choice") this.handlers.reward(message.offer);
        else if (message.type === "results") this.handlers.result(message.result);
        else session.stop("protocol-error");
      },
    });
    this.session = session;
    session.start();
  }
  leave(): void {
    this.session?.leave();
    this.session = null;
    this.pending = [];
    this.playerId = "";
  }
  send(message: ClientMessage): void {
    if (this.session?.status.phase === "connected") this.session.send(JSON.stringify(message));
  }
  sendInput(input: InputFrame): void {
    if (this.session?.status.phase !== "connected" || !this.playerId) return;
    if (this.pending.length >= 180) {
      this.session.retry();
      return;
    }
    this.pending.push(input);
    this.send({ input, type: "input", v: PROTOCOL_VERSION });
  }
  get localPlayerId(): string {
    return this.playerId;
  }
}

function resumeKey(room: string): string {
  return `edgefall-resume-v2:${room}`;
}
