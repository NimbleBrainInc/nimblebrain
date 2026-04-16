import { Command } from "commander";
import { status } from "../commands.ts";

export function createStatusCommand(): Command {
  return new Command("status")
    .description("Show workspace status")
    .action((_opts: unknown, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      status(globals.config, globals.json);
    });
}
