import { App, Testing } from "cdktn";
import { describe, expect, it } from "vitest";
import { EdgefallStack } from "../src/stacks/edgefall-stack.js";

describe("EdgefallStack", () => {
  const synthesized = Testing.synth(new EdgefallStack(new App(), "test"), true);

  it("configures the Cloudflare provider and account lookup", () => {
    expect(Testing.toHaveProvider(synthesized, "cloudflare")).toBe(true);
    expect(
      Testing.toHaveDataSourceWithProperties(synthesized, "cloudflare_accounts", {
        direction: "asc",
        max_items: 1,
      }),
    ).toBe(true);
  });

  it("creates globally replicated run history and replay storage", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_d1_database", {
        name: "edgefall-runs",
        read_replication: { mode: "auto" },
      }),
    ).toBe(true);
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_r2_bucket", {
        name: "edgefall-replays",
        storage_class: "Standard",
      }),
    ).toBe(true);
  });

  it("uploads the bundled authoritative game Worker", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script", {
        script_name: "edgefall",
        main_module: "index.js",
        compatibility_date: "2026-08-30",
        compatibility_flags: ["nodejs_compat"],
        observability: { enabled: true },
      }),
    ).toBe(true);

    const script = JSON.parse(synthesized).resource.cloudflare_workers_script.EdgefallWorker;
    expect(script.content_file).toMatch(/^assets\/EdgefallWorkerBundle\/.+\/index\.js$/);
    expect(script.content_sha256).toBe(`\${filesha256("${script.content_file}")}`);
  });

  it("creates and binds the SQLite Durable Object room", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script", {
        migrations: {
          new_tag: "v1",
          new_sqlite_classes: ["EdgefallRoom"],
        },
      }),
    ).toBe(true);
  });

  it("binds game rooms, run history, and replay storage", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script", {
        bindings: [
          {
            type: "durable_object_namespace",
            name: "GAME_ROOMS",
            class_name: "EdgefallRoom",
          },
          {
            type: "d1",
            name: "RUNS",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
            database_id: "${cloudflare_d1_database.Runs.id}",
          },
          {
            type: "r2_bucket",
            name: "REPLAYS",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
            bucket_name: "${cloudflare_r2_bucket.Replays.name}",
          },
        ],
      }),
    ).toBe(true);
  });

  it("publishes the game on workers.dev", () => {
    expect(
      Testing.toHaveResourceWithProperties(synthesized, "cloudflare_workers_script_subdomain", {
        enabled: true,
        previews_enabled: true,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
        script_name: "${cloudflare_workers_script.EdgefallWorker.script_name}",
      }),
    ).toBe(true);
  });
});
