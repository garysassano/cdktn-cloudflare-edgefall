"""Read Linux clocks during a capture without changing clock or service settings."""

import json
import sys
import time
from pathlib import Path

names = ["CLOCK_REALTIME", "CLOCK_MONOTONIC", "CLOCK_MONOTONIC_RAW", "CLOCK_BOOTTIME"]
clocks = {name: getattr(time, name) for name in names}


def sample():
    return {name: time.clock_gettime_ns(clock) for name, clock in clocks.items()}


start = sample()
previous = start
events = []
samples = []
next_checkpoint = 5
reads = 1
while True:
    time.sleep(0.05)
    current = sample()
    reads += 1
    elapsed = {name: (current[name] - start[name]) / 1e9 for name in clocks}
    delta = {name: (current[name] - previous[name]) / 1e9 for name in clocks}
    offset_change = delta["CLOCK_REALTIME"] - delta["CLOCK_MONOTONIC"]
    if delta["CLOCK_REALTIME"] < 0 or abs(offset_change) > 0.005:
        events.append({
            "atMonotonicSeconds": elapsed["CLOCK_MONOTONIC"],
            "realtimeBackwards": delta["CLOCK_REALTIME"] < 0,
            "offsetChangeSeconds": offset_change,
            "deltaSeconds": delta,
        })
    if elapsed["CLOCK_MONOTONIC"] >= next_checkpoint:
        samples.append(elapsed)
        next_checkpoint += 5
    previous = current
    if elapsed["CLOCK_MONOTONIC"] >= 60:
        break

result = {
    "scope": "Read-only Linux clocks during the serial browser matrix; no clock, service or host setting changes",
    "clocksource": Path("/sys/devices/system/clocksource/clocksource0/current_clocksource").read_text().strip(),
    "requestedIntervalSeconds": 0.05,
    "reads": reads,
    "finalElapsedSeconds": elapsed,
    "realtimeBacksteps": sum(event["realtimeBackwards"] for event in events),
    "offsetChanges": events,
    "samples": samples,
}
Path(sys.argv[1]).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: result[key] for key in ["clocksource", "reads", "finalElapsedSeconds", "realtimeBacksteps", "offsetChanges"]}))
