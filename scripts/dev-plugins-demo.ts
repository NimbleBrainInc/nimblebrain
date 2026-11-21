#!/usr/bin/env bun
/**
 * `bun run dev:plugins-demo` — the platform on a seeded workdir for judging the
 * Plugins page at scale and in every state, with no sign-in anywhere.
 *
 * Local developer tooling. It starts the mock MCP servers the connected
 * plugins point at (`scripts/lib/plugins-demo/mock-servers.ts`), seeds
 * `.environments/plugins-demo/` through the runtime's own stores
 * (`scripts/lib/plugins-demo/seed.ts`), then runs `scripts/dev.ts` against it
 * with the demo catalog. The mock servers live in this process, so they stop
 * when the demo does.
 *
 * Ports: API 27255, Web 27254 (override via `NB_API_PORT` / `NB_WEB_PORT`).
 * Reset: `git clean -fdX .environments/plugins-demo && bun run dev:plugins-demo`.
 *
 * The demo owns its workdir: `NB_WORK_DIR` is pinned to the demo directory for
 * the seed and the runtime alike, so neither an exported value nor one in a
 * `.env` (which `scripts/dev.ts` applies only to keys not already set) can send
 * either one to another workdir.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/cli/config.ts";
import { log } from "../src/observability/log.ts";
import { MOCK_SERVERS } from "./lib/plugins-demo/fixtures.ts";
import { startMockFleet } from "./lib/plugins-demo/mock-servers.ts";
import { seedPluginsDemo } from "./lib/plugins-demo/seed.ts";

const ROOT = dirname(import.meta.dir);
const ENV_DIR = join(ROOT, ".environments", "plugins-demo");
const CONFIG_PATH = join(ENV_DIR, "nimblebrain.json");
const CATALOG_DIR = join(ENV_DIR, "catalog");

/** The demo's ports: `NB_API_PORT` / `NB_WEB_PORT` from `env`, else 27255 / 27254. */
export function demoPorts(env: NodeJS.ProcessEnv): { api: string; web: string } {
  return { api: env.NB_API_PORT || "27255", web: env.NB_WEB_PORT || "27254" };
}

/**
 * The environment the seed and the runtime both run under: `base` with the
 * demo's workdir, ports, and catalog. `scripts/dev.ts` builds the origins from
 * these ports.
 */
export function demoEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ports = demoPorts(base);
  return {
    ...base,
    NB_WORK_DIR: ENV_DIR,
    NB_API_PORT: ports.api,
    NB_WEB_PORT: ports.web,
    NB_CURATED_CATALOG_DIR: CATALOG_DIR,
  };
}

async function main(): Promise<void> {
  const ports = demoPorts(process.env);
  const env = demoEnv(process.env);
  process.env.NB_WORK_DIR = env.NB_WORK_DIR;
  const { workDir, secrets } = loadConfig({ config: CONFIG_PATH });
  if (workDir !== ENV_DIR) throw new Error(`workDir resolved to ${workDir}, not ${ENV_DIR}`);

  const fleet = startMockFleet(MOCK_SERVERS);
  const summary = await seedPluginsDemo({ workDir, catalogDir: CATALOG_DIR, fleet, secrets });
  log.info(`[plugins-demo] Seeded ${workDir}`);
  for (const ws of summary.workspaces) {
    log.info(`[plugins-demo]   ${ws.name} (${ws.id}): ${JSON.stringify(ws.plugins)}`);
  }
  log.info(
    `[plugins-demo]   ${summary.personal} personal plugins; skills ${JSON.stringify(summary.skills)}`,
  );
  log.info(`[plugins-demo]   Web: http://localhost:${ports.web}`);

  const child = spawn(
    "bun",
    [
      "--no-env-file",
      join(ROOT, "scripts", "dev.ts"),
      "--port",
      ports.api,
      "--config",
      CONFIG_PATH,
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
      env,
    },
  );
  // `scripts/dev.ts` shuts its own children down on these; keep the mocks up until it has.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code) => {
    fleet.close();
    process.exit(code ?? 0);
  });
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(`[plugins-demo] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
