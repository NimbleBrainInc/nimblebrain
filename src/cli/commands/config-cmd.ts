import { Command } from "commander";
import { configClear, configGet, configSet } from "../commands.ts";

export function createConfigCommand(): Command {
  const cmd = new Command("config").description("Configure bundle settings").action(() => {
    process.stderr.write(cmd.helpInformation());
    process.exit(2);
  });

  cmd
    .command("set")
    .description("Set a config value for a bundle in a workspace")
    .argument("<bundle>", "bundle name (e.g., @scope/name)")
    .argument("<key-value>", "key=value pair")
    .requiredOption("-w, --workspace <wsId>", "workspace id (required)")
    .action(async (bundle: string, keyValue: string, opts: { workspace: string }) => {
      await configSet(bundle, keyValue, opts.workspace);
    });

  cmd
    .command("get")
    .description("Get config value(s) for a bundle in a workspace")
    .argument("<bundle>", "bundle name")
    .requiredOption("-w, --workspace <wsId>", "workspace id (required)")
    .action(async (bundle: string, opts: { workspace: string }) => {
      await configGet(bundle, opts.workspace);
    });

  cmd
    .command("clear")
    .description("Remove a config value for a bundle in a workspace")
    .argument("<bundle>", "bundle name")
    .argument("<key>", "config key to remove")
    .requiredOption("-w, --workspace <wsId>", "workspace id (required)")
    .action(async (bundle: string, key: string, opts: { workspace: string }) => {
      await configClear(bundle, key, opts.workspace);
    });

  return cmd;
}
