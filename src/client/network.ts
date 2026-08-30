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

export interface ConnectionHandlers {
  events: (events: GameplayEvent[]) => void;
  lobby: (message: Extract<ServerMessage, { type: "lobby" }>) => void;
  result: (result: RunResult) => void;
  reward: (offer: RewardOffer) => void;
  snapshot: (snapshot: CompactSnapshot, playerId: string, pending: readonly InputFrame[]) => void;
  status: (status: "connected" | "connecting" | "disconnected" | "reconnecting") => void;
  warning: (message: string) => void;
}

export class RoomConnection {
  private attempt = 0;
  private generation = 0;
  private name = "Operative";
  private pending: InputFrame[] = [];
  private playerId = "";
  private room = "";
  private socket?: WebSocket;

  constructor(private readonly handlers: ConnectionHandlers) {}

  async connect(room: string, name: string): Promise<void> {
    this.generation += 1;
    this.socket?.close(1000, "Changing rooms");
    this.room = room;
    this.name = name;
    this.playerId = "";
    this.pending = [];
    this.attempt = 0;
    await this.ensureProfile();
    this.open(this.generation, false);
  }

  leave(): void {
    this.generation += 1;
    this.room = "";
    this.playerId = "";
    this.pending = [];
    this.socket?.close(1000, "Left room");
    this.socket = undefined;
    this.handlers.status("disconnected");
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  sendInput(input: InputFrame): void {
    this.pending.push(input);
    if (this.pending.length > 180) this.pending.shift();
    this.send({ input, type: "input", v: PROTOCOL_VERSION });
  }

  get localPlayerId(): string {
    return this.playerId;
  }

  private open(generation: number, reconnecting: boolean): void {
    if (!this.room || generation !== this.generation) return;
    this.handlers.status(reconnecting ? "reconnecting" : "connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/rooms/${encodeURIComponent(this.room)}`,
    );
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.attempt = 0;
      this.handlers.status("connected");
      const resumeToken = localStorage.getItem(resumeKey(this.room));
      if (resumeToken) {
        this.send({ resumeToken, type: "resume", v: PROTOCOL_VERSION });
      } else {
        this.send({ name: this.name, type: "join", v: PROTOCOL_VERSION });
      }
    });
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", (event) => {
      if (generation !== this.generation || !this.room || event.code === 1000) return;
      this.scheduleReconnect(generation);
    });
    socket.addEventListener("error", () => {
      if (generation === this.generation) this.handlers.warning("The rail signal is unstable.");
    });
  }

  private receive(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.handlers.warning("Received an unreadable room message.");
      return;
    }
    if (message.v !== PROTOCOL_VERSION) {
      this.handlers.warning("This room uses a different Edgefall protocol version.");
      return;
    }
    if (message.type === "error") {
      if (message.code === "resume_expired") {
        localStorage.removeItem(resumeKey(this.room));
        this.send({ name: this.name, type: "join", v: PROTOCOL_VERSION });
      } else {
        this.handlers.warning(message.message);
      }
      return;
    }
    if (message.type === "lobby") {
      if (message.you) this.playerId = message.you;
      if (message.resumeToken) localStorage.setItem(resumeKey(this.room), message.resumeToken);
      this.handlers.lobby(message);
      return;
    }
    if (message.type === "snapshot") {
      this.pending = this.pending.filter((input) => input.sequence > message.acknowledgedInput);
      this.handlers.snapshot(message.snapshot, this.playerId, this.pending);
      return;
    }
    if (message.type === "gameplay-events") {
      this.handlers.events(message.events);
      return;
    }
    if (message.type === "reward-choice") {
      this.handlers.reward(message.offer);
      return;
    }
    this.handlers.result(message.result);
  }

  private scheduleReconnect(generation: number): void {
    this.attempt += 1;
    this.handlers.status("reconnecting");
    const delay = Math.min(3_000, 300 * 2 ** Math.min(this.attempt, 4));
    window.setTimeout(() => this.open(generation, true), delay);
  }

  private async ensureProfile(): Promise<void> {
    const response = await fetch("/api/profile", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not create an anonymous browser profile");
  }
}

function resumeKey(room: string): string {
  return `edgefall-resume-v2:${room}`;
}
