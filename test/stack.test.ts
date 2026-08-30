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

  it("exports backing resource identifiers for the Wrangler-owned deployment", () => {
    const template = JSON.parse(synthesized);
    expect(template.output).toEqual({
      replays_bucket_name: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
        value: "${cloudflare_r2_bucket.Replays.name}",
      },
      runs_database_id: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Terraform interpolation
        value: "${cloudflare_d1_database.Runs.id}",
      },
    });
  });

  it("does not let CDKTN own Worker code, migrations, routes, or static assets", () => {
    const resources = JSON.parse(synthesized).resource;
    expect(resources.cloudflare_workers_script).toBeUndefined();
    expect(resources.cloudflare_workers_script_subdomain).toBeUndefined();
  });
});
