import { DurableObject } from "cloudflare:workers";
import { type ClockSample, RoomClock } from "../runtime/room-clock.js";

interface ProbeEnv {
  CLOCK_PROBES: DurableObjectNamespace<ClockProbe>;
}

/** Local-only W02 lifecycle fixture. No gameplay, production routing, storage or cloud resources. */
export class ClockProbe extends DurableObject<ProbeEnv> {
  private readonly instanceId = crypto.randomUUID();
  private readonly samples: ClockSample[] = [];
  private timerCount = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private limit = 0;
  private readonly clock = new RoomClock({
    initialTick: 0,
    port: {
      now: () => performance.now(),
      schedule: (callback, delay) => {
        this.timerCount++;
        let active = true;
        const handle = setTimeout(() => {
          if (!active) return;
          active = false;
          this.timerCount--;
          callback();
        }, delay);
        return () => {
          if (!active) return;
          active = false;
          this.timerCount--;
          clearTimeout(handle);
        };
      },
    },
    step: (tick) => {
      if (tick >= this.limit) this.stop();
    },
    onSample: (sample) => {
      // Includes early callbacks but bounded independently from successfully completed ticks.
      if (this.samples.length >= 2400) {
        this.stop();
        return;
      }
      this.samples.push(sample);
    },
    onDiscontinuity: () => this.clearWatchdog(),
  });

  private clearWatchdog(): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private stop(): void {
    this.clock.stop();
    this.clearWatchdog();
  }

  fetch(request: Request): Response {
    const action = new URL(request.url).pathname;
    if (action !== "/status" && request.method !== "POST")
      return new Response("Use POST", { status: 405 });
    if (action === "/start") {
      if (this.clock.state.mode !== "stopped" || this.clock.state.tick >= 600) {
        return new Response("Probe unavailable", { status: 409 });
      }
      this.limit = Math.min(600, this.clock.state.tick + 120);
      // A second independent timer bounds the entire active diagnostic, then is removed on pause.
      this.watchdog = setTimeout(() => this.stop(), 10_000);
      this.clock.start();
    } else if (action === "/stop") this.stop();
    else if (action === "/close") {
      this.stop();
      this.clock.close();
    } else if (action !== "/status") return new Response("Not found", { status: 404 });
    return Response.json({
      instanceId: this.instanceId,
      clock: this.clock.state,
      timerCount: this.timerCount,
      watchdogPending: this.watchdog !== null,
      samples: this.samples,
    });
  }
}

export default {
  fetch(request: Request, env: ProbeEnv): Response | Promise<Response> {
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response("Local only", { status: 403 });
    if (url.pathname === "/health") return Response.json({ fixture: "edgefall-clock-probe" });
    return env.CLOCK_PROBES.getByName("bounded-local-lifecycle").fetch(request);
  },
};
