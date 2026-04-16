import { Command } from "commander";
import { skillInfo, skillList } from "../commands.ts";

export function createSkillCommand(): Command {
  const cmd = new Command("skill").description("Inspect loaded skills").action(() => {
    process.stderr.write(cmd.helpInformation());
    process.exit(2);
  });

  cmd
    .command("list")
    .description("List all loaded skills")
    .action((_opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      skillList(globals.config, globals.json);
    });

  cmd
    .command("info")
    .description("Show details for a skill")
    .argument("<name>", "skill name")
    .action((name: string, _opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      skillInfo(name, globals.config);
    });

  return cmd;
}
