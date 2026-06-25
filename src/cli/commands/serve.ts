import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ConsoleEventSink } from "../../adapters/console-events.ts";
import { DebugEventSink } from "../../adapters/debug-events.ts";
import { startServerWithShutdown } from "../../api/server.ts";
import { createSessionRegistry, resolveSessionStoreConfig } from "../../api/session-store/index.ts";
import { Runtime } from "../../runtime/runtime.ts";
import type { TelemetryManager } from "../../telemetry/manager.ts";
import { loadConfig } from "../config.ts";
import { log } from "../../observability/log.ts";

export function createServeCommand(telemetry: TelemetryManager): Command {
  return new Command("serve")
    .description("Start HTTP API server")
    .option("--port <number>", "server port")
    .action(async (opts: { port?: string }, cmd: Command) => {
      const globals = cmd.optsWithGlobals();

      const config = loadConfig({
        config: globals.config,
        model: globals.model,
        defaultWorkDir: process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain"),
      });

      config.events = [globals.debug ? new DebugEventSink() : new ConsoleEventSink()];

      log.info("[nimblebrain] Starting runtime...");
      const startupTime = performance.now();
      const runtime = await Runtime.start(config);
      const startupMs = Math.round(performance.now() - startupTime);
      telemetry.capture("cli.startup", {
        mode: "serve",
        bundle_count: runtime.bundleNames().length,
        startup_ms: startupMs,
      });
      log.info("[nimblebrain] Runtime ready.");

      // Build the MCP session metadata store from config. Defaults to in-
      // memory; production deploys point this at Redis. Resolution + connect
      // happens here (not in `startServer`) so misconfiguration fails the
      // boot loudly instead of every individual MCP request.
      const sessionStoreConfig = resolveSessionStoreConfig(runtime.getSessionStoreConfig());
      const sessionRegistry = await createSessionRegistry(sessionStoreConfig);
      // Multi-replica intent (Redis-backed sessions) implies the operator may
      // run platform.replicas > 1. RunBus is still single-process — turn
      // replay/resume only works on the pod that holds the run. Sticky routing
      // on Mcp-Session-Id (CLAUDE.md prereq #2) mitigates for the active tab
      // but a pod restart / cross-pod viewer still drops the in-flight turn.
      // Loud heads-up at boot; not a hard error (sticky routing is enough for
      // most cases, and operators may accept the gap until the clustered
      // RunBus lands).
      if (sessionStoreConfig.type === "redis") {
        log.warn(
          "[nimblebrain] sessionStore=redis detected. RunBus is still single-process; " +
            "if platform.replicas > 1, a viewer that hits a different pod sees " +
            "isActive:false for an in-flight turn. Ensure Mcp-Session-Id sticky " +
            "routing is in place (CLAUDE.md replicas>1 prereq #2); RunBus Redis port " +
            "is tracked as deferred work.",
        );
      }

      const port = Number(process.env.PORT) || Number(opts.port) || 27247;
      await startServerWithShutdown({ runtime, port, sessionRegistry });
    });
}
