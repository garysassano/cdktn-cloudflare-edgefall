# Worker observability

`wrangler.jsonc` enables Worker traces and invocation logs with a sampling rate of `1`, and uploads source maps. `scripts/build-deploy-config.mjs` carries those settings into `.wrangler.deploy.json` alongside the CDK Terrain resource identifiers. Cloudflare currently requires the explicit `observability.traces.enabled` setting; `observability.enabled` alone enables logs. See the [Cloudflare tracing configuration](https://developers.cloudflare.com/workers/observability/traces/).

The live account check on 2026-09-08 authenticated through the existing Wrangler OAuth profile. The Workers list did not contain `edgefall`, and the documented script-settings endpoint returned HTTP 404 with Cloudflare code `10007`, stating that the Worker does not exist in that account. The [sanitized result](redesign-evidence/observability-live-account.json) retains the target-specific evidence without credentials or an inventory of unrelated services. This check made no deployment or settings changes. Live Edgefall trace ingestion remains unverified.

After an authorized deployment, confirm the active version and script-level tracing/log settings, exercise an actual Worker API request and room flow, and retrieve the resulting invocation and trace in Workers Observability. Static asset requests alone may bypass Worker code. A real-time log stream is available with:

```sh
pnpm exec wrangler tail --config .wrangler.deploy.json --format json --sampling-rate 1
```

Use `$metadata.service = edgefall` when searching across traces and logs. Keep the successful request's timestamp and request/trace identifiers with the version under test. An active tail proves real-time event delivery; a retained Observability query is needed to prove stored log/trace ingestion. Avoid retaining profile cookies, WebSocket resume claims or authentication headers in diagnostic artifacts.

The local redesign diagnostics already retain accepted input decisions, snapshot and event sizes, bounded queue/voice counts, deterministic world hashes, recording replay, SQLite recovery and browser clock comparisons. `pnpm bench:room`, `pnpm bench:room:network`, `pnpm bench:room:timers` and the scenario-specific browser verifiers exercise different parts of that system. Their reports state whether they use Node, Chromium, local workerd or a deployed Worker; local results are not deployed timing evidence.

The [2026-09-08 host clock probe](redesign-evidence/W04-host-clocks.md) reproduced the timing discrepancy directly in Linux and retained three negative wall-clock sample deltas. It also found a large kernel clock adjustment consistent with the observed monotonic/raw rate difference. This is a concrete host diagnosis lead; the source of the adjustments and deployed cadence still require verification.

Cloudflare tracing does not provide precise timing for every synchronous simulation step: the runtime clock may stay unchanged between I/O events, producing a `0 ms` span for computation. Keep simulation benchmarks and CPU profiles alongside request traces before deciding whether a Rust/Wasm experiment addresses a measured bottleneck. Cloudflare documents this [clock limitation](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).
