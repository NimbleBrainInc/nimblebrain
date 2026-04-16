import { Command } from "commander";

export function createUserCommand(): Command {
  const cmd = new Command("user").description("Manage users").action(() => {
    process.stderr.write(cmd.helpInformation());
    process.exit(2);
  });

  return cmd;
}
