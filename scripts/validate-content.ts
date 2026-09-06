import { createHash } from "node:crypto";
import { CONTRACT_FIXTURE } from "../src/game/content/contract-fixture.js";
import { validateContent } from "../src/game/content/validate.js";
import { canonical } from "../src/game/core/canonical.js";

validateContent(CONTRACT_FIXTURE);
const contentHash = createHash("sha256").update(canonical(CONTRACT_FIXTURE)).digest("hex");
console.log(
  JSON.stringify({
    format: 1,
    fixture: "arcade-contract",
    contentHash,
    status: "valid",
    media: "engineering fixture; final asset availability not asserted",
  }),
);
