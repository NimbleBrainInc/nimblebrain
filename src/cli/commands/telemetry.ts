import { Command } from "commander";
import { telemetryOff, telemetryOn, telemetryReset, telemetryStatus } from "../commands.ts";

export function createTelemetryCommand(workDir: string): Command {
  const cmd = new Command("telemetry")
    .description("Manage anonymous usage telemetry")
    .action(() => {
      process.stderr.write(cmd.helpInformation());
      process.exit(2);
    });

  cmd
    .command("on")
    .description("Enable telemetry")
    .action((_opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      telemetryOn(globals.config);
    });

  cmd
    .command("off")
    .description("Disable telemetry")
    .action((_opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      telemetryOff(globals.config);
    });

  cmd
    .command("status")
    .description("Show current telemetry state")
    .action((_opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      telemetryStatus(globals.config, workDir);
    });

  cmd
    .command("reset")
    .description("Reset anonymous ID")
    .action(() => {
      telemetryReset(workDir);
    });

  return cmd;
}
