# Host clock discrepancy during the review matrix

The wall/monotonic discrepancy is observable directly in Linux, outside the browser and game. Two read-only Python probes ran while the serial W06 captures continued on 2026-09-08. The finer probe made 1,194 samples, sleeping 50 ms between reads, and retained three negative `CLOCK_REALTIME` deltas. Their wall-clock changes were −0.728047, −1.002389 and −1.816663 seconds, while the corresponding monotonic deltas remained about +0.050 seconds. The first two occurred in adjacent sampling windows; this does not identify three separate adjustment sources.

| Clock | Elapsed seconds in the fine probe |
| --- | ---: |
| `CLOCK_REALTIME` | 56.328843 |
| `CLOCK_MONOTONIC` | 60.026612 |
| `CLOCK_MONOTONIC_RAW` | 56.325642 |
| `CLOCK_BOOTTIME` | 60.026612 |

The coarse probe independently recorded 60.002648 monotonic seconds against 56.332624 wall seconds and 56.334434 raw seconds. These are host measurements, not evidence that a deployed Worker behaves this way. The [probe, measurements and context](host-clock-2026-09-08/artifacts.json) are retained with SHA-256 fingerprints.

The selected clocksource was `tsc`. The time service reported NTP enabled and synchronized. A read-only `adjtimex` call with `modes = 0` returned `tick = 10658` microseconds, `freq = 919156` in scaled ppm units, and status `8192`; `getconf CLK_TCK` returned `100`. The coarse tick value is 6.58% above 10,000 microseconds, consistent with the measured 6.5707% monotonic/raw difference. This identifies a significant kernel clock adjustment, but does not establish which service selected it or which component causes the wall-clock corrections.

Linux documents that realtime can jump, monotonic avoids those jumps while remaining subject to frequency adjustments, and the raw monotonic clock excludes those adjustments. The `adjtimex` modes select whether parameters are changed; zero performs the inspection used here. See the [clock definitions](https://man7.org/linux/man-pages/man2/clock_gettime.2.html) and [kernel adjustment API](https://man7.org/linux/man-pages/man2/adjtimex.2.html).

The capture reports retain wall time separately and validate media duration, WebAudio time and browser monotonic time. That keeps the recorded specimen inspectable; it does not establish absolute host clock accuracy or physical-device playback timing. No clocksource, kernel adjustment, time service or Windows setting was changed. The next timing work should identify the owners of the frequency adjustment and wall corrections, repeat the clocks and network probes on a stable host, and then complete the distinct deployed Worker cadence gate. No reference-clock comparison, host repair or live timing acceptance is claimed.

To repeat the fine probe on Linux, provide a fresh output path:

```sh
python3 docs/redesign-evidence/host-clock-2026-09-08/probe.py /tmp/edgefall-linux-clocks-new.json
```
