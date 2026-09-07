import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { canonical } from "../src/game/core/canonical.js";
import { COMBAT_CONTENT } from "../src/game/labs/combat-content.js";
import {
  BREAKWATER,
  BREAKWATER_PROPS,
  BREAKWATER_TERRAIN,
} from "../src/game/missions/breakwater-content.js";

const bytes = `${JSON.stringify(
  {
    format: 1,
    contentHash: createHash("sha256")
      .update(
        canonical({
          mission: BREAKWATER,
          terrain: BREAKWATER_TERRAIN,
          props: BREAKWATER_PROPS,
          combat: COMBAT_CONTENT,
        }),
      )
      .digest("hex"),
  },
  null,
  2,
)}\n`;
const output = "src/game/missions/compiled/breakwater.json";
if (process.argv.includes("--check"))
  assert.equal(await readFile(output, "utf8"), bytes, "Stale mission content digest");
else {
  await mkdir("src/game/missions/compiled", { recursive: true });
  await writeFile(output, bytes);
}
console.log(JSON.stringify({ status: "pass", content: BREAKWATER.id, ...JSON.parse(bytes) }));
