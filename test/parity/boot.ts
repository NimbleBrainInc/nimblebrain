/**
 * Boot a runtime and its HTTP server for the parity suite, from a source tree.
 *
 * The tree defaults to this one. `root` names another checkout (a `main`
 * worktree), so the same scenarios run against both trees: the runtime and the
 * server are imported from `root`, while the model, the people and the catalog
 * fixture are this suite's own, and reach that runtime only through
 * `Runtime.start`'s config.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { UserStore } from "../../src/identity/user.ts";
import { createDirectiveModel } from "./directive-model.ts";
import { CATALOG_NAME, startCatalogFixture } from "./fixtures.ts";
import { TokenIdentityProvider } from "./identities.ts";

/** This checkout's root. */
export const THIS_TREE = resolve(import.meta.dir, "../..");

/**
 * The attachment limit a booted runtime enforces: small, so the refused
 * oversize case is a small request. The other limits are the defaults.
 */
export const PARITY_MAX_FILE_SIZE = 2 * 1024 * 1024;

/** The model every turn reports: priced, so a spend budget is spent. */
export const PARITY_MODEL = "anthropic:claude-sonnet-5-5";

/** The slice of `Runtime` this file calls, typed loosely: another tree's may differ. */
interface BootedRuntime {
  shutdown(): Promise<void>;
}

interface RuntimeModule {
  Runtime: { start(config: Record<string, unknown>): Promise<BootedRuntime> };
}

interface ServerModule {
  startServer(options: { runtime: BootedRuntime; port: number; hostname?: string }): {
    port: number;
    stop(force?: boolean): void;
  };
}

export interface Booted {
  baseUrl: string;
  /** The catalog fixture's artifact server. */
  catalogBase: string;
  /** The tree the runtime was imported from. */
  root: string;
  workDir: string;
  stop(): Promise<void>;
}

export async function bootParityRuntime(
  opts: { root?: string; port?: number } = {},
): Promise<Booted> {
  const root = resolve(opts.root ?? THIS_TREE);

  const workDir = mkdtempSync(join(tmpdir(), "nb-parity-"));
  const catalog = startCatalogFixture(workDir);
  const { Runtime } = (await import(join(root, "src/runtime/runtime.ts"))) as RuntimeModule;
  const { startServer } = (await import(join(root, "src/api/server.ts"))) as ServerModule;
  const model: LanguageModelV4 = createDirectiveModel();
  const runtime = await Runtime.start({
    workDir,
    identityProvider: ({ userStore }: { userStore: UserStore }) =>
      new TokenIdentityProvider(userStore),
    languageModel: model,
    models: { default: PARITY_MODEL, fast: PARITY_MODEL },
    modelPolicy: { allowed: [PARITY_MODEL] },
    logging: { disabled: true },
    telemetry: { enabled: false },
    catalogs: [{ source: catalog.listingPath, policy: "available", name: CATALOG_NAME }],
    files: { maxFileSize: PARITY_MAX_FILE_SIZE },
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
    root,
    workDir,
    async stop() {
      server.stop(true);
      await runtime.shutdown();
      catalog.stop();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
