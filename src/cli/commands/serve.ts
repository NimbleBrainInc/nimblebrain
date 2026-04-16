import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { ConsoleEventSink } from "../../adapters/console-events.ts";
import { DebugEventSink } from "../../adapters/debug-events.ts";
import { startServerWithShutdown } from "../../api/server.ts";
import { Runtime } from "../../runtime/runtime.ts";
import type { TelemetryManager } from "../../telemetry/manager.ts";
import { loadConfig } from "../config.ts";
import { log } from "../log.ts";

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

      const port = Number(process.env.PORT) || Number(opts.port) || 27247;
      await startServerWithShutdown({ runtime, port });
    });
}
