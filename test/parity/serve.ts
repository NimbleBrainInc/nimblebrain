/**
 * Serve a parity runtime from a source tree until stopped, for a run against
 * another checkout: `bun --no-env-file test/parity/serve.ts <root>`.
 *
 * Prints one JSON line, `{"baseUrl", "catalogBase"}`, once it listens.
 */

import { bootParityRuntime } from "./boot.ts";

const root = process.argv[2];
const booted = await bootParityRuntime(root ? { root } : {});
process.stdout.write(
  `${JSON.stringify({ baseUrl: booted.baseUrl, catalogBase: booted.catalogBase })}\n`,
);

const stop = async () => {
  await booted.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
