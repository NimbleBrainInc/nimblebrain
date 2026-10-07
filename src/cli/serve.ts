import { ConsoleEventSink } from "../adapters/console-events.ts";
import { DebugEventSink } from "../adapters/debug-events.ts";
import { startServerWithShutdown } from "../api/server.ts";
import { defaultWorkDir } from "../connectors/runtime/paths.ts";
import { log } from "../observability/log.ts";
import { Runtime } from "../runtime/runtime.ts";
import type { TelemetryManager } from "../telemetry/manager.ts";
import { loadConfig } from "./config.ts";

export interface ServeOptions {
  config?: string;
  port?: number;
  debug?: boolean;
}

/** Start the HTTP API server. This is the managed-services entry point. */
export async function runServe(opts: ServeOptions, telemetry: TelemetryManager): Promise<void> {
  const config = loadConfig({
    config: opts.config,
    defaultWorkDir: defaultWorkDir(),
  });

  config.events = [opts.debug ? new DebugEventSink() : new ConsoleEventSink()];

  log.info("[nimblebrain] Starting runtime...");
  const startupTime = performance.now();
  const runtime = await Runtime.start(config);
  const startupMs = Math.round(performance.now() - startupTime);
  telemetry.capture("cli.startup", {
    mode: "serve",
    connector_count: runtime.connectorNames().length,
    startup_ms: startupMs,
  });
  log.info("[nimblebrain] Runtime ready.");

  const port = Number(process.env.PORT) || opts.port || 27247;
  await startServerWithShutdown({ runtime, port });
}
