import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetType, Fn, TerraformAsset, TerraformStack } from "cdktn";
import type { Construct } from "constructs";
import { D1Database } from "../../.gen/providers/cloudflare/d1-database/index.js";
import { DataCloudflareAccounts } from "../../.gen/providers/cloudflare/data-cloudflare-accounts/index.js";
import { CloudflareProvider } from "../../.gen/providers/cloudflare/provider/index.js";
import { R2Bucket } from "../../.gen/providers/cloudflare/r2-bucket/index.js";
import { WorkersScript } from "../../.gen/providers/cloudflare/workers-script/index.js";
import { WorkersScriptSubdomain } from "../../.gen/providers/cloudflare/workers-script-subdomain/index.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const compatibilityDate = "2026-08-30";

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

    const workerBundle = new TerraformAsset(this, "EdgefallWorkerBundle", {
      path: join(projectRoot, "dist", "index.js"),
      type: AssetType.FILE,
    });

    const worker = new WorkersScript(this, "EdgefallWorker", {
      accountId,
      scriptName: "edgefall",
      contentFile: workerBundle.path,
      contentSha256: Fn.filesha256(workerBundle.path),
      mainModule: "index.js",
      compatibilityDate,
      compatibilityFlags: ["nodejs_compat"],
      observability: { enabled: true },
      migrations: {
        newTag: "v1",
        newSqliteClasses: ["EdgefallRoom"],
      },
      bindings: [
        {
          type: "durable_object_namespace",
          name: "GAME_ROOMS",
          className: "EdgefallRoom",
        },
        {
          type: "d1",
          name: "RUNS",
          databaseId: runs.id,
        },
        {
          type: "r2_bucket",
          name: "REPLAYS",
          bucketName: replays.name,
        },
      ],
    });

    new WorkersScriptSubdomain(this, "EdgefallSubdomain", {
      accountId,
      scriptName: worker.scriptName,
      enabled: true,
      previewsEnabled: true,
    });
  }
}
