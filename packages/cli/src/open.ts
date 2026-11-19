import type { Deps } from "./deps.ts";
import type { Ctx } from "./lifecycle.ts";
import { CliError } from "./result.ts";
import { installUrl, isUp, readInstall } from "./status.ts";

/**
 * The program that opens a URL in this machine's default browser, with the URL
 * as its own argument, never inside a shell string. None where no browser can
 * show it to the person: Linux with no display (`xdg-open` would fall back to
 * a text browser in the terminal, or fail), and an SSH session (the browser
 * would open on the remote machine's screen). Windows is not a platform the
 * CLI supports, so it gets none either.
 */
export function browserCommand(
  deps: Pick<Deps, "platform" | "env">,
  url: string,
): { cmd: string; args: string[] } | undefined {
  const { env } = deps;
  if (env.SSH_CONNECTION || env.SSH_TTY) return undefined;
  if (deps.platform === "darwin") return { cmd: "open", args: [url] };
  if (deps.platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY))
    return { cmd: "xdg-open", args: [url] };
  return undefined;
}

/** Opens `url` in the default browser; false when there is none to open or the opener failed. Never throws. */
export async function openBrowser(deps: Deps, url: string): Promise<boolean> {
  const command = browserCommand(deps, url);
  if (!command) return false;
  return deps.launch(command.cmd, command.args);
}

/**
 * `open`: the install's web UI in the default browser. It runs for an agent
 * too (`--json`, no terminal), since a person who asks their agent to open
 * NimbleBrain wants exactly this; where no browser can be started it still
 * succeeds, with `opened: false` and the URL to hand on. A stopped runtime is
 * `NOT_RUNNING`, never started here: starting is `up`'s job.
 */
export async function open(ctx: Ctx) {
  const { deps, home } = ctx;
  const install = await readInstall(deps, home);
  if (!install) throw new CliError("NOT_INSTALLED", `No NimbleBrain install in ${home}.`);
  const url = installUrl(install);
  if (!(await isUp(deps, url)))
    throw new CliError("NOT_RUNNING", "NimbleBrain is not running.", { url });
  return { ok: true as const, url, opened: await openBrowser(deps, url) };
}
