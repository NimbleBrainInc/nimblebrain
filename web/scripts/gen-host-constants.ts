/**
 * Writes `schemas/host-bridge/v1/constants.json` at the repo root, the host's
 * bridge constants as one document, from `src/bridge/host-constants.ts`. Run via
 * `bun run gen:host-constants`.
 *
 * The output is committed, and `test/unit/bridge/host-constants.test.ts` at the
 * repo root fails when it differs from what the bridge's source builds. Edit
 * the source a value comes from, never this output.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeHostConstants } from "../src/bridge/host-constants.ts";

const outPath = join(
  import.meta.dir,
  "..",
  "..",
  "schemas",
  "host-bridge",
  "v1",
  "constants.json",
);
writeFileSync(outPath, serializeHostConstants());
console.log(`wrote ${outPath}`);
