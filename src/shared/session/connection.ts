export type ConnectionReason =
  | "outage"
  | "reservation-expired"
  | "room-full"
  | "in-progress"
  | "incompatible-build"
  | "profile-required"
  | "replaced"
  | "protocol-error"
  | "room-ended";
export interface ConnectionStatus {
  phase: "idle" | "connecting" | "awaiting-baseline" | "connected" | "retrying" | "stopped";
  generation: number;
  attempt: number;
  reason: ConnectionReason | null;
  retryAtMs: number | null;
}
export class RoomConnectError extends Error {
  constructor(readonly reason: ConnectionReason) {
    super(reason);
  }
}
export interface ConnectionPort {
  now(): number;
  random(): number;
  schedule(callback: () => void, delayMs: number): () => void;
  socket(url: string): ConnectionSocket;
}
export type ConnectionSocket = WebSocket & { readonly bufferedAmount: number };
interface ConnectionOptions {
  port: ConnectionPort;
  /** Resolve/authenticate the same room. Never create another room after a failed resume. */
  prepare(signal: AbortSignal): Promise<string>;
  opened(generation: number): void;
  message(data: unknown, generation: number): void;
  suspended(): void;
  status(status: ConnectionStatus): void;
  classifyClose?(code: number, reason: string): ConnectionReason;
  automatic?: boolean;
}
export const CONNECTION_RETRY_WINDOW_MS = 90_000;
export const CONNECTION_HANDSHAKE_MS = 5000;
const STABLE_CONNECTION_MS = 5000;
/** Equal jitter, bounded below to avoid spinning and above to cap reconnect traffic. */
export function reconnectDelay(attempt: number, random: number): number {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isFinite(random) ||
    random < 0 ||
    random >= 1
  )
    throw new Error("Invalid reconnect policy input");
  const cap = Math.min(3000, 300 * 2 ** Math.min(attempt - 1, 4));
  return Math.floor(cap * (0.5 + random * 0.5));
}
export function connectionText(status: ConnectionStatus): string {
  if (status.phase === "idle") return "Disconnected";
  if (status.phase === "connecting") return "Connecting to the room…";
  if (status.phase === "awaiting-baseline") return "Synchronizing with the room…";
  if (status.phase === "connected") return "Connected";
  if (status.phase === "retrying") return "Connection interrupted. Reconnecting to the same room…";
  const messages: Record<ConnectionReason, string> = {
    outage: "The room is temporarily unavailable. Reconnect to try again.",
    "reservation-expired": "Your reserved place has expired. Choose a room to join.",
    "room-full": "This room is full.",
    "in-progress": "This mission is in progress. New players can join between missions.",
    "incompatible-build": "This room uses a different game build. Reload to continue.",
    "profile-required": "Your browser profile is unavailable. Return to the lobby to reconnect.",
    replaced: "This player connected in another tab. This tab has stopped controlling the room.",
    "protocol-error": "The room sent an invalid response. The connection has stopped.",
    "room-ended": "This room has ended.",
  };
  return messages[status.reason ?? "outage"];
}
/** One attempt generation, one deadline timer, no queued gameplay and no overlapping retries. */
export class RoomSocketConnection {
  private socket: ConnectionSocket | null = null;
  private controller: AbortController | null = null;
  private cancelTimer: (() => void) | null = null;
  private generation = 0;
  private attempt = 0;
  private outageSince: number | null = null;
  private readySince: number | null = null;
  private value: ConnectionStatus = {
    phase: "idle",
    generation: 0,
    attempt: 0,
    reason: null,
    retryAtMs: null,
  };
  constructor(private readonly options: ConnectionOptions) {}
  get status(): ConnectionStatus {
    return { ...this.value };
  }
  private publish(
    phase: ConnectionStatus["phase"],
    reason: ConnectionReason | null = null,
    retryAtMs: number | null = null,
  ) {
    this.value = { phase, generation: this.generation, attempt: this.attempt, reason, retryAtMs };
    this.options.status(this.status);
  }
  private clearTimer() {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
  private invalidate() {
    // Fence callbacks before close/abort: either can synchronously dispatch in a test adapter.
    this.generation++;
    this.clearTimer();
    this.controller?.abort();
    this.controller = null;
    const old = this.socket;
    this.socket = null;
    this.options.suspended();
    if (old)
      try {
        old.close(1000, "connection-retired");
      } catch {
        /* Already closed. */
      }
  }
  start(): void {
    this.invalidate();
    this.attempt = 0;
    this.outageSince = null;
    this.readySince = null;
    void this.begin();
  }
  leave(): void {
    this.invalidate();
    this.readySince = null;
    this.publish("idle");
  }
  stop(reason: ConnectionReason): void {
    this.invalidate();
    this.readySince = null;
    this.publish("stopped", reason);
  }
  private async begin(): Promise<void> {
    this.invalidate();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.publish("connecting");
    if (generation !== this.generation || controller.signal.aborted) return;
    const remaining =
      this.outageSince === null
        ? CONNECTION_HANDSHAKE_MS
        : Math.min(
            CONNECTION_HANDSHAKE_MS,
            CONNECTION_RETRY_WINDOW_MS - (this.options.port.now() - this.outageSince),
          );
    if (remaining <= 0) {
      this.stop("reservation-expired");
      return;
    }
    this.cancelTimer = this.options.port.schedule(() => {
      if (generation === this.generation) this.retry();
    }, remaining);
    try {
      const url = await this.options.prepare(controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      const socket = this.options.port.socket(url);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      const current = () => generation === this.generation && this.socket === socket;
      socket.addEventListener("open", () => {
        if (!current()) return;
        this.publish("awaiting-baseline");
        if (!current()) return;
        try {
          this.options.opened(generation);
        } catch {
          this.stop("protocol-error");
        }
      });
      socket.addEventListener("message", (event) => {
        if (current())
          try {
            this.options.message(event.data, generation);
          } catch {
            this.stop("protocol-error");
          }
      });
      socket.addEventListener("error", () => {
        if (current()) this.retry();
      });
      socket.addEventListener("close", (event) => {
        if (!current()) return;
        const reason =
          this.options.classifyClose?.(event.code, event.reason) ??
          (event.code === 1000 ? "room-ended" : "outage");
        if (reason === "outage") this.retry();
        else this.stop(reason);
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof RoomConnectError && error.reason !== "outage") this.stop(error.reason);
      else this.retry();
    }
  }
  /** Only the application can confirm its validated identity/full baseline, never socket open. */
  ready(generation: number): boolean {
    if (generation !== this.generation || this.value.phase !== "awaiting-baseline") return false;
    if (
      this.outageSince !== null &&
      this.options.port.now() - this.outageSince >= CONNECTION_RETRY_WINDOW_MS
    ) {
      this.stop("reservation-expired");
      return false;
    }
    this.clearTimer();
    this.readySince = this.options.port.now();
    this.publish("connected");
    return generation === this.generation && this.status.phase === "connected";
  }
  retry(): void {
    if (
      this.value.phase === "idle" ||
      this.value.phase === "stopped" ||
      this.value.phase === "retrying"
    )
      return;
    const now = this.options.port.now();
    if (this.readySince !== null && now - this.readySince >= STABLE_CONNECTION_MS) {
      this.outageSince = null;
      this.attempt = 0;
    }
    this.outageSince ??= now;
    this.readySince = null;
    this.invalidate();
    if (now - this.outageSince >= CONNECTION_RETRY_WINDOW_MS) {
      this.publish("stopped", "reservation-expired");
      return;
    }
    if (this.options.automatic === false) {
      this.publish("stopped", "outage");
      return;
    }
    this.attempt++;
    const delay = Math.min(
      reconnectDelay(this.attempt, this.options.port.random()),
      CONNECTION_RETRY_WINDOW_MS - (now - this.outageSince),
    );
    const generation = this.generation;
    this.publish("retrying", "outage", now + delay);
    if (generation !== this.generation) return;
    this.cancelTimer = this.options.port.schedule(() => {
      if (generation === this.generation) void this.begin();
    }, delay);
  }
  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): boolean {
    if (
      this.socket?.readyState !== 1 ||
      (this.value.phase !== "connected" && this.value.phase !== "awaiting-baseline")
    )
      return false;
    if (this.socket.bufferedAmount > 4096) {
      this.retry();
      return false;
    }
    try {
      this.socket.send(data);
      return true;
    } catch {
      this.retry();
      return false;
    }
  }
}
