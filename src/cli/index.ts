#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { initTracing } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import { TelemetryManager } from "../telemetry/manager.ts";
import { runServe } from "./serve.ts";

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

  // Accept (and ignore) a leading `serve` token for deploy-command stability.
  const argv = process.argv.slice(2);
  if (argv[0] === "serve") argv.shift();

  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c" },
      model: { type: "string" },
      port: { type: "string" },
      debug: { type: "boolean" },
    },
    allowPositionals: false,
  });

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
