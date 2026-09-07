import {
  type ConnectionSocket,
  type ConnectionStatus,
  RoomSocketConnection,
} from "../../src/shared/session/connection.js";
export class FakeSocket extends EventTarget {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  sent: unknown[] = [];
  send(data: unknown) {
    if (this.readyState !== 1) throw new Error("closed");
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  closed(code = 1006, reason = "") {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}
export const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
export function harness(
  prepare: (signal: AbortSignal) => Promise<string> = async () => "ws://room.test/same-room",
  onStatus: (status: ConnectionStatus) => void = () => {},
) {
  let now = 0,
    suspended = 0;
  const tasks: Array<{ active: boolean; at: number; run: () => void }> = [],
    sockets: FakeSocket[] = [],
    statuses: ConnectionStatus[] = [],
    received: unknown[] = [],
    opened: number[] = [];
  const connection = new RoomSocketConnection({
    port: {
      now: () => now,
      random: () => 0.5,
      schedule: (run, ms) => {
        const t = { active: true, at: now + ms, run };
        tasks.push(t);
        return () => {
          t.active = false;
        };
      },
      socket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as ConnectionSocket;
      },
    },
    prepare,
    suspended: () => {
      suspended++;
    },
    opened: (generation) => {
      opened.push(generation);
    },
    message: (data) => {
      received.push(data);
    },
    status: (s) => {
      statuses.push(s);
      onStatus(s);
    },
  });
  return {
    connection,
    sockets,
    tasks,
    statuses,
    received,
    opened,
    get suspended() {
      return suspended;
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = tasks.filter((t) => t.active && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.active = false;
        next.run();
        await settle();
      }
      now = target;
      await settle();
    },
    async start() {
      connection.start();
      await settle();
      return required(sockets.at(-1));
    },
  };
}
export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
