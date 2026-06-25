#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { initTracing } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import { TelemetryManager } from "../telemetry/manager.ts";
import { runDev } from "./dev.ts";
import { runServe } from "./serve.ts";

const USAGE = "Usage: nb <serve|dev> [options]\n";

/**
 * Process entry point. Dispatches the two server-side commands the platform
 * runs — `serve` (the managed-services HTTP server) and `dev` (the local
 * watch/HMR loop). No interactive terminal client; the web shell and `/mcp`
 * are the runtime's UIs. Kept at this path so the image/chart command
 * (`bun run src/cli/index.ts serve`) is unchanged.
 */
async function main(): Promise<void> {
  // Install vendor-neutral OTel tracing once, before anything runs. No-op
  // (nothing exported) unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
  initTracing();

  const command = process.argv[2];
  const rest = process.argv.slice(3);

  const telemetry = TelemetryManager.create({
    workDir: join(homedir(), ".nimblebrain"),
    mode: command === "serve" || command === "dev" ? command : undefined,
  });

  try {
    if (command === "serve") {
      const { values } = parseArgs({
        args: rest,
        options: {
          config: { type: "string", short: "c" },
          model: { type: "string" },
          port: { type: "string" },
          debug: { type: "boolean" },
        },
        allowPositionals: false,
      });
      await runServe(
        {
          config: values.config,
          model: values.model,
          port: values.port ? Number(values.port) : undefined,
          debug: values.debug ?? false,
        },
        telemetry,
      );
    } else if (command === "dev") {
      const { values } = parseArgs({
        args: rest,
        // strict:false so the `--no-web` negation token passes through; we read
        // it off argv directly since parseArgs has no boolean-negation support.
        strict: false,
        options: {
          config: { type: "string", short: "c" },
          port: { type: "string" },
          app: { type: "string" },
          "app-port": { type: "string" },
          debug: { type: "boolean" },
        },
      });
      await runDev({
        port: values.port ? Number(values.port) : 27247,
        noWeb: rest.includes("--no-web"),
        config: values.config as string | undefined,
        debug: (values.debug as boolean | undefined) ?? false,
        app: values.app as string | undefined,
        appPort: values["app-port"] ? Number(values["app-port"]) : undefined,
      });
    } else {
      process.stderr.write(command ? `Unknown command: ${command}\n${USAGE}` : USAGE);
      await telemetry.shutdown();
      process.exit(command ? 2 : 0);
    }
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
