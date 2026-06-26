#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { initTracing } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import { TelemetryManager } from "../telemetry/manager.ts";
import { runServe } from "./serve.ts";

/**
 * Parse server flags, accepting (and ignoring) a leading `serve` token so the
 * image/chart command `bun run src/cli/index.ts serve` is unchanged. A bad flag
 * or stray positional is a usage error (exit 2), distinct from a runtime failure
 * (exit 1). NOTE: the only behavioral difference between the `serve` strip being
 * present vs. absent is whether a *bare* `serve` boots — `serve <garbage>` exits
 * non-zero either way — so the deploy contract is pinned by the integration boot
 * smoke, not by an arg-parse assertion.
 */
function parseServeArgs(argv: string[]) {
  const args = argv[0] === "serve" ? argv.slice(1) : argv;
  try {
    return parseArgs({
      args,
      options: {
        config: { type: "string", short: "c" },
        model: { type: "string" },
        port: { type: "string" },
        debug: { type: "boolean" },
      },
      allowPositionals: false,
    }).values;
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n` +
        "Usage: bun run src/cli/index.ts [serve] [--config <path>] [--port <n>] [--model <id>] [--debug]\n",
    );
    process.exit(2);
  }
}

/**
 * Process entry point: boot the HTTP API server. Serving is the one thing the
 * runtime binary does — the web shell and `/mcp` are its UIs. Local dev
 * orchestration (watch + web HMR) is tooling, not runtime: it lives in
 * `scripts/dev.ts` (`bun run dev`), which spawns this entry in watch mode.
 *
 * The image/chart invoke this as `bun run src/cli/index.ts serve [flags]`; the
 * leading `serve` token is accepted and ignored so the deploy command is
 * unchanged. Flags: --config/-c, --model, --port, --debug.
 */
async function main(): Promise<void> {
  // Install vendor-neutral OTel tracing once, before anything runs. No-op
  // (nothing exported) unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
  initTracing();

  const values = parseServeArgs(process.argv.slice(2));

  const telemetry = TelemetryManager.create({ workDir: join(homedir(), ".nimblebrain") });
  try {
    await runServe(
      {
        config: values.config,
        model: values.model,
        port: values.port ? Number(values.port) : undefined,
        debug: values.debug ?? false,
      },
      telemetry,
    );
  } catch (err) {
    log.error(`Fatal: ${err}`);
    await telemetry.shutdown();
    process.exit(1);
  }
  await telemetry.shutdown();
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
