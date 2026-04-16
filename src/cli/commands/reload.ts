import { Command } from "commander";
import { reload } from "../commands.ts";

export function createReloadCommand(): Command {
  return new Command("reload").description("Hot-reload bundles and config").action(() => {
    reload();
  });
}
