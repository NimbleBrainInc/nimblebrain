import { ConsoleEventSink } from "../adapters/console-events.ts";
import { DebugEventSink } from "../adapters/debug-events.ts";
import { startServerWithShutdown } from "../api/server.ts";
import { createSessionRegistry, resolveSessionStoreConfig } from "../api/session-store/index.ts";
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

  // Build the MCP session metadata store from config. Defaults to in-memory;
  // production deploys point this at Redis. Resolution + connect happens here
  // (not in `startServer`) so misconfiguration fails the boot loudly instead of
  // every individual MCP request.
  const sessionStoreConfig = resolveSessionStoreConfig(runtime.getSessionStoreConfig());
  const sessionRegistry = await createSessionRegistry(sessionStoreConfig);
  // Redis-backed sessions suggest the operator means to run more than one
  // replica, which is not supported: the runtime assumes it is the only process
  // on a tenant's data (src/api/AGENTS.md, "Running more than one replica").
  // A heads-up at boot rather than a hard error, because Redis sessions are
  // also valid at one replica.
  if (sessionStoreConfig.type === "redis") {
    log.warn(
      "[nimblebrain] sessionStore=redis detected. Run platform.replicas: 1; more " +
        "than one replica is not supported (automations and notifications run once " +
        "per pod, writes to workspace data race, and caches and live events stay on " +
        "the pod that made them).",
    );
  }

  const port = Number(process.env.PORT) || opts.port || 27247;
  await startServerWithShutdown({ runtime, port, sessionRegistry });
}
