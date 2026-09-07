import type { ConnectionPort } from "../shared/session/connection.js";

export function browserConnectionPort(): ConnectionPort {
  return {
    now: () => performance.now(),
    random: () => Math.random(),
    socket: (url) => new WebSocket(url),
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  };
}
