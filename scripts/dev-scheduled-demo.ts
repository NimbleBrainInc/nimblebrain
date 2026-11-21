#!/usr/bin/env bun
/**
 * `bun run dev:scheduled-demo` — the platform on a seeded workdir for judging
 * the Scheduled page (the tasks app's panel) with a full board and run
 * history, with no sign-in anywhere.
 *
 * Local developer tooling. It seeds `.environments/scheduled-demo/` through
 * the runtime's own stores (`scripts/lib/scheduled-demo/seed.ts`), then runs
 * `scripts/dev.ts` against it. Every launch rewrites the demo's tasks with
 * times relative to now, so the board always reads as current.
 *
 * Ports: API 27257, Web 27256 (override via `NB_API_PORT` / `NB_WEB_PORT`).
 * Reset: `git clean -fdX .environments/scheduled-demo && bun run dev:scheduled-demo`.
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
import { seedScheduledDemo } from "./lib/scheduled-demo/seed.ts";

const ROOT = dirname(import.meta.dir);
const ENV_DIR = join(ROOT, ".environments", "scheduled-demo");
const CONFIG_PATH = join(ENV_DIR, "nimblebrain.json");

/** The demo's ports: `NB_API_PORT` / `NB_WEB_PORT` from `env`, else 27257 / 27256. */
export function demoPorts(env: NodeJS.ProcessEnv): { api: string; web: string } {
  return { api: env.NB_API_PORT || "27257", web: env.NB_WEB_PORT || "27256" };
}

/**
 * The environment the seed and the runtime both run under: `base` with the
 * demo's workdir and ports. `scripts/dev.ts` builds the origins from these ports.
 */
export function demoEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ports = demoPorts(base);
  return { ...base, NB_WORK_DIR: ENV_DIR, NB_API_PORT: ports.api, NB_WEB_PORT: ports.web };
}

async function main(): Promise<void> {
  const ports = demoPorts(process.env);
  const env = demoEnv(process.env);
  process.env.NB_WORK_DIR = env.NB_WORK_DIR;
  const { workDir } = loadConfig({ config: CONFIG_PATH });
  if (workDir !== ENV_DIR) throw new Error(`workDir resolved to ${workDir}, not ${ENV_DIR}`);

  const summary = await seedScheduledDemo({ workDir });
  log.info(`[scheduled-demo] Seeded ${workDir}`);
  log.info(
    `[scheduled-demo]   ${summary.tasks} tasks, ${summary.oneoffs} one-offs, ${summary.batches} batches, ${summary.runs} runs in ${summary.workspaceId}`,
  );
  log.info(`[scheduled-demo]   Web: http://localhost:${ports.web}`);

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
    { cwd: ROOT, stdio: "inherit", env },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (import.meta.main) {
  main().catch((err) => {
    log.error(`[scheduled-demo] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
