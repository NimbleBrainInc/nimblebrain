/**
 * Boot this tree's runtime and its HTTP server for the end-to-end suite.
 *
 * The runtime gets the suite's directive model, its two token-signed people
 * and its fixture catalog through `Runtime.start`'s config, and is reached from
 * then on only over the wire (`client.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createDirectiveModel } from "./directive-model.ts";
import { CATALOG_NAME, startCatalogFixture } from "./fixtures.ts";
import { TokenIdentityProvider } from "./identities.ts";

/** This checkout's root. */
export const THIS_TREE = resolve(import.meta.dir, "../..");

/**
 * The attachment limit a booted runtime enforces: small, so the refused
 * oversize case is a small request. The other limits are the defaults.
 */
export const MAX_FILE_SIZE = 2 * 1024 * 1024;

/** The model every turn reports: priced, so a spend budget is spent. */
export const SUITE_MODEL = "anthropic:claude-sonnet-5-5";

export interface Booted {
  baseUrl: string;
  /** The catalog fixture's artifact server. */
  catalogBase: string;
  workDir: string;
  stop(): Promise<void>;
}

export async function bootRuntime(opts: { port?: number } = {}): Promise<Booted> {
  const workDir = mkdtempSync(join(tmpdir(), "nb-e2e-"));
  const catalog = startCatalogFixture(workDir);
  const runtime = await Runtime.start({
    workDir,
    identityProvider: ({ userStore }) => new TokenIdentityProvider(userStore),
    languageModel: createDirectiveModel(),
    models: { default: SUITE_MODEL, fast: SUITE_MODEL },
    modelPolicy: { allowed: [SUITE_MODEL] },
    logging: { disabled: true },
    telemetry: { enabled: false },
    catalogs: [{ source: catalog.listingPath, policy: "available", name: CATALOG_NAME }],
    files: { maxFileSize: MAX_FILE_SIZE },
  });
  // A run starts a few dozen turns a minute as one person: past the default
  // chat limit (20 a minute), which is a pressure test's subject, not this
  // one's. The server reads the limit as it starts; the variable is put back
  // after, since a test process shares its environment across files.
  const chatLimit = process.env.NB_CHAT_RATE_LIMIT;
  process.env.NB_CHAT_RATE_LIMIT = chatLimit ?? "1000";
  const server = startServer({ runtime, port: opts.port ?? 0, hostname: "127.0.0.1" });
  if (chatLimit === undefined) delete process.env.NB_CHAT_RATE_LIMIT;
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    catalogBase: catalog.base,
    workDir,
    async stop() {
      server.stop(true);
      await runtime.shutdown();
      catalog.stop();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
