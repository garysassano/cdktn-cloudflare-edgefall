import { TerraformOutput, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { D1Database } from "../../.gen/providers/cloudflare/d1-database/index.js";
import { DataCloudflareAccounts } from "../../.gen/providers/cloudflare/data-cloudflare-accounts/index.js";
import { CloudflareProvider } from "../../.gen/providers/cloudflare/provider/index.js";
import { R2Bucket } from "../../.gen/providers/cloudflare/r2-bucket/index.js";

export class EdgefallStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new CloudflareProvider(this, "CloudflareProvider");

    const accounts = new DataCloudflareAccounts(this, "CloudflareAccounts", {
      direction: "asc",
      maxItems: 1,
    });
    const accountId = accounts.result.get(0).id;

    const runs = new D1Database(this, "Runs", {
      accountId,
      name: "edgefall-runs",
      readReplication: { mode: "auto" },
    });

    const replays = new R2Bucket(this, "Replays", {
      accountId,
      name: "edgefall-replays",
      storageClass: "Standard",
    });
    new TerraformOutput(this, "runs_database_id", {
      value: runs.id,
    });
    new TerraformOutput(this, "replays_bucket_name", {
      value: replays.name,
    });
  }
}
