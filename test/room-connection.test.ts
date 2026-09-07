import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConnectionHandlers, RoomConnection } from "../src/client/network.js";
import { PROTOCOL_VERSION } from "../src/game/protocol.js";
import { EMPTY_INPUT } from "../src/game/simulation.js";
import type { ConnectionPort, ConnectionSocket } from "../src/shared/session/connection.js";
import { FakeSocket, required, settle } from "./fixtures/connection-port.js";

afterEach(() => {
  vi.unstubAllGlobals();
});
function setup() {
  const sockets: FakeSocket[] = [],
    urls: string[] = [],
    timers: Array<() => void> = [],
    stored = new Map<string, string>();
  const fetcher = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("location", new URL("https://edgefall.test/"));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  const port: ConnectionPort = {
    now: () => 0,
    random: () => 0.5,
    schedule: (callback) => {
      timers.push(callback);
      return () => {};
    },
    socket: (url) => {
      urls.push(url);
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as ConnectionSocket;
    },
  };
  const handlers: ConnectionHandlers = {
    events: vi.fn(),
    lobby: vi.fn(),
    result: vi.fn(),
    reward: vi.fn(),
    snapshot: vi.fn(),
    status: vi.fn(),
    warning: vi.fn(),
  };
  const connection = new RoomConnection(handlers, port, "https://edgefall.test");
  const lobby = (socket: FakeSocket, you = "player-one") =>
    socket.message(
      JSON.stringify({
        type: "lobby",
        v: PROTOCOL_VERSION,
        roomCode: "same-room",
        players: [],
        locked: false,
        you,
        resumeToken: "reserved-token",
      }),
    );
  return {
    sockets,
    timers,
    urls,
    stored,
    fetcher,
    handlers,
    connection,
    lobby,
    async open() {
      connection.connect("same-room", "Operative");
      await settle();
      const socket = required(sockets.at(-1));
      socket.open();
      return socket;
    },
  };
}
describe("production room connection adapter", () => {
  it("never converts an expired resume into a new join or run", async () => {
    const h = setup();
    h.stored.set("edgefall-resume-v2:same-room", "expired-token");
    const socket = await h.open();
    expect(JSON.parse(String(socket.sent[0])).type).toBe("resume");
    socket.message(
      JSON.stringify({
        type: "error",
        v: PROTOCOL_VERSION,
        code: "resume_expired",
        message: "expired",
      }),
    );
    expect(socket.sent).toHaveLength(1);
    expect(h.handlers.status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "stopped", reason: "reservation-expired" }),
    );
    for (const timer of h.timers) timer();
    await settle();
    expect(h.sockets).toHaveLength(1);
    expect(h.stored.has("edgefall-resume-v2:same-room")).toBe(false);
  });
  it("fences messages and stale profile completion when changing rooms", async () => {
    const h = setup();
    const old = await h.open();
    h.lobby(old);
    const lobbies = vi.mocked(h.handlers.lobby).mock.calls.length;
    h.connection.connect("new-room", "Other");
    await settle();
    old.message(
      JSON.stringify({
        type: "lobby",
        v: PROTOCOL_VERSION,
        you: "stale",
        roomCode: "old-room",
        resumeToken: "stolen",
        players: [],
        locked: false,
      }),
    );
    expect(h.handlers.lobby).toHaveBeenCalledTimes(lobbies);
    expect(h.connection.localPlayerId).toBe("");
    const pending: Array<() => void> = [];
    h.fetcher.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(new Response("{}")))),
    );
    h.connection.connect("first-pending", "First");
    h.connection.connect("second-pending", "Second");
    required(pending[0])();
    await settle();
    expect(h.urls.at(-1)).toContain("new-room");
    required(pending[1])();
    await settle();
    expect(h.urls.at(-1)).toContain("second-pending");
    h.connection.leave();
  });
  it("does not send or retain offline input and resumes the same reservation", async () => {
    const h = setup();
    const socket = await h.open();
    h.lobby(socket);
    h.connection.sendInput({ ...EMPTY_INPUT, sequence: 1 });
    expect(socket.sent).toHaveLength(2);
    socket.closed();
    h.connection.sendInput({ ...EMPTY_INPUT, sequence: 2 });
    required(h.timers.at(-1))();
    await settle();
    const next = required(h.sockets[1]);
    next.open();
    expect(JSON.parse(String(next.sent[0]))).toMatchObject({
      type: "resume",
      resumeToken: "reserved-token",
    });
    h.lobby(next);
    next.message(
      JSON.stringify({ type: "snapshot", v: PROTOCOL_VERSION, acknowledgedInput: 1, snapshot: {} }),
    );
    expect(h.handlers.snapshot).toHaveBeenLastCalledWith({}, "player-one", []);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.connection.leave();
  });
  it("shows incompatible/full/replaced states without continuing gameplay", async () => {
    for (const reason of ["incompatible-build", "room-full", "replaced"] as const) {
      const h = setup();
      const socket = await h.open();
      if (reason === "replaced") socket.closed(1000, "Reconnected elsewhere");
      else
        socket.message(
          JSON.stringify({
            type: "error",
            v: reason === "incompatible-build" ? 1 : PROTOCOL_VERSION,
            code: "room_full",
            message: "full",
          }),
        );
      expect(h.handlers.status).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: "stopped", reason }),
      );
      h.connection.sendInput({ ...EMPTY_INPUT, sequence: 1 });
      expect(socket.sent).toHaveLength(1);
      h.connection.leave();
    }
  });
});
