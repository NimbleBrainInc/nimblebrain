import { Command } from "commander";
import { runDev } from "../dev.ts";

export function createDevCommand(): Command {
  return new Command("dev")
    .description("Start dev mode (API with watch + web HMR)")
    .option("--port <number>", "API server port")
    .option("--no-web", "skip web dev server")
    .option("--app <path>", "path to app directory for Vite HMR dev server")
    .option("--app-port <number>", "Vite dev server port for --app (default: 5173)")
    .action(
      async (
        opts: { port?: string; web: boolean; app?: string; appPort?: string },
        cmd: Command,
      ) => {
        const globals = cmd.optsWithGlobals();
        await runDev({
          port: Number(opts.port) || 27247,
          noWeb: opts.web === false,
          config: globals.config,
          debug: globals.debug ?? false,
          app: opts.app,
          appPort: opts.appPort ? Number(opts.appPort) : undefined,
        });
      },
    );
}
