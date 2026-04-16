#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";
import { TelemetryManager } from "../telemetry/manager.ts";
import { createAutomationCommand } from "./commands/automation.ts";
import { createBundleCommand } from "./commands/bundle.ts";
import { createConfigCommand } from "./commands/config-cmd.ts";
import { registerDefaultAction } from "./commands/default.ts";
import { createDevCommand } from "./commands/dev.ts";
import { createReloadCommand } from "./commands/reload.ts";
import { createServeCommand } from "./commands/serve.ts";
import { createSkillCommand } from "./commands/skill.ts";
import { createStatusCommand } from "./commands/status.ts";
import { createTelemetryCommand } from "./commands/telemetry.ts";
import { createUserCommand } from "./commands/user.ts";
import { log } from "./log.ts";
import { createProgram, determineModeFromArgv } from "./program.ts";

const KNOWN_COMMANDS = new Set([
  "serve",
  "dev",
  "bundle",
  "skill",
  "config",
  "status",
  "reload",
  "telemetry",
  "automation",
  "user",
]);

async function main() {
  // Pre-check for unknown subcommands (before Commander parses)
  const firstArg = process.argv[2];
  if (firstArg && !firstArg.startsWith("-") && !KNOWN_COMMANDS.has(firstArg)) {
    process.stderr.write(`Unknown command: ${firstArg}\nRun 'nb --help' for usage.\n`);
    process.exit(2);
  }

  const telemetryWorkDir = join(homedir(), ".nimblebrain");

  const telemetry = TelemetryManager.create({
    workDir: telemetryWorkDir,
    mode: determineModeFromArgv(),
  });

  const program = createProgram(telemetry);

  // Register all subcommands
  program.addCommand(createStatusCommand());
  program.addCommand(createReloadCommand());
  program.addCommand(createTelemetryCommand(telemetryWorkDir));
  program.addCommand(createSkillCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createBundleCommand());
  program.addCommand(createAutomationCommand());
  program.addCommand(createServeCommand(telemetry));
  program.addCommand(createDevCommand());
  program.addCommand(createUserCommand());

  // Default action: TUI or headless (when no subcommand given)
  registerDefaultAction(program, telemetry);

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // exitOverride throws CommanderError instead of calling process.exit
      // Exit code 0 = --help or --version (normal exit)
      await telemetry.shutdown();
      if (err.exitCode !== 0) {
        process.exit(err.exitCode);
      }
    } else {
      log.error(`Fatal: ${err}`);
      await telemetry.shutdown();
      process.exit(1);
    }
  }

  await telemetry.shutdown();
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
