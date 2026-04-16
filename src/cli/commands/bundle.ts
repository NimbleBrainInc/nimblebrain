import { Command } from "commander";
import { bundleAdd, bundleAddRemote, bundleList, bundleRemove, bundleSearch } from "../commands.ts";

export function createBundleCommand(): Command {
  const cmd = new Command("bundle").description("Manage installed bundles").action(() => {
    process.stderr.write(cmd.helpInformation());
    process.exit(2);
  });

  cmd
    .command("list")
    .description("List installed bundles")
    .action((_opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      bundleList(globals.config, globals.json);
    });

  cmd
    .command("add")
    .description("Install a bundle")
    .argument("[name]", "bundle name from registry")
    .option("--url <url>", "remote server URL")
    .option("--name <serverName>", "server name for remote install")
    .option("--auth <type>", "auth type (bearer|header)")
    .option("--token <token>", "auth token")
    .action(
      (name: string | undefined, opts: Record<string, string | undefined>, subcmd: Command) => {
        const globals = subcmd.optsWithGlobals();
        if (opts.url) {
          if (!opts.name) {
            subcmd.error("--name is required when using --url", { exitCode: 2 });
          }
          bundleAddRemote(opts.url, opts.name!, opts.auth, opts.token, globals.config);
        } else if (name) {
          bundleAdd(name, globals.config);
        } else {
          subcmd.error("Provide a bundle name or --url + --name", { exitCode: 2 });
        }
      },
    );

  cmd
    .command("remove")
    .description("Uninstall a bundle")
    .argument("<name>", "bundle name/path/url to remove")
    .action((name: string, _opts: unknown, subcmd: Command) => {
      const globals = subcmd.optsWithGlobals();
      bundleRemove(name, globals.config);
    });

  cmd
    .command("search")
    .description("Search mpak registry")
    .argument("<query>", "search query")
    .action((query: string) => {
      bundleSearch(query);
    });

  return cmd;
}
