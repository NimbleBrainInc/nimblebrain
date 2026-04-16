import { Command } from "commander";
import { configClear, configGet, configSet } from "../commands.ts";

export function createConfigCommand(): Command {
  const cmd = new Command("config").description("Configure bundle settings").action(() => {
    process.stderr.write(cmd.helpInformation());
    process.exit(2);
  });

  cmd
    .command("set")
    .description("Set a config value")
    .argument("<bundle>", "bundle name (e.g., @scope/name)")
    .argument("<key-value>", "key=value pair")
    .action((bundle: string, keyValue: string) => {
      configSet(bundle, keyValue);
    });

  cmd
    .command("get")
    .description("Get config value(s)")
    .argument("<bundle>", "bundle name")
    .action((bundle: string) => {
      configGet(bundle);
    });

  cmd
    .command("clear")
    .description("Remove a config value")
    .argument("<bundle>", "bundle name")
    .argument("<key>", "config key to remove")
    .action((bundle: string, key: string) => {
      configClear(bundle, key);
    });

  return cmd;
}
