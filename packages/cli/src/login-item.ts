import { join } from "node:path";
import type { Deps } from "./deps.ts";

/**
 * The agent worker as a macOS login item: a per-user LaunchAgent that launchd
 * starts at login and again whenever the worker stops with an error, so a
 * reboot or a crash does not leave chat without its worker. Docker Desktop
 * starts NimbleBrain at login the same way.
 *
 * Per user only (`~/Library/LaunchAgents`, `gui/<uid>`): never `sudo`, never a
 * LaunchDaemon. One per install, named by its Compose project, so two homes
 * each keep their own.
 */

export const LABEL_PREFIX = "ai.nimblebrain.agent-worker";

export interface LoginItem {
  label: string;
  /** `~/Library/LaunchAgents/<label>.plist`. */
  path: string;
}

export function loginItem(deps: Deps, project: string): LoginItem {
  const label = `${LABEL_PREFIX}.${project}`;
  return { label, path: join(deps.home, "Library", "LaunchAgents", `${label}.plist`) };
}

/**
 * The variables the worker needs from this shell: `PATH`, so launchd finds
 * the `claude` or `codex` the person runs (launchd's own is
 * `/usr/bin:/bin:/usr/sbin:/sbin`), `HOME`, and where each CLI keeps its
 * sign-in when it is not the default. Never a key: the worker strips them
 * anyway, and the plist is a file anyone on this account can read.
 */
const PASSED = ["PATH", "HOME", "LANG", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

/** The LaunchAgent's plist: the worker's command, kept alive, its output in `log`. */
export function plist(
  item: LoginItem,
  program: string[],
  log: string,
  env: NodeJS.ProcessEnv,
): string {
  const vars = PASSED.filter((k) => env[k]).map(
    (k) => `      <key>${k}</key>\n      <string>${xml(env[k] ?? "")}</string>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(item.label)}</string>
    <key>ProgramArguments</key>
    <array>
${program.map((a) => `      <string>${xml(a)}</string>`).join("\n")}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${vars.join("\n")}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
  </dict>
</plist>
`;
}

function xml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const domain = (deps: Deps) => `gui/${deps.uid}`;

/**
 * Loads the plist into this user's launchd, which starts the worker now
 * (`RunAtLoad`). A label still unloading answers an error for a moment, so
 * it is tried a few times. True when launchd took it.
 */
export async function bootstrap(deps: Deps, item: LoginItem): Promise<boolean> {
  for (let tries = 0; tries < 5; tries++) {
    const res = await deps.exec("launchctl", ["bootstrap", domain(deps), item.path]);
    if (res.code === 0) return true;
    await deps.sleep(500);
  }
  return false;
}

/** Unloads it, which stops the worker. True when one was loaded. */
export async function bootout(deps: Deps, item: LoginItem): Promise<boolean> {
  const res = await deps.exec("launchctl", ["bootout", `${domain(deps)}/${item.label}`]);
  return res.code === 0;
}

/** What launchd says of it: its pid while it runs, the last exit code once it has stopped. */
export async function printed(
  deps: Deps,
  item: LoginItem,
): Promise<{ loaded: boolean; pid?: number; lastExit?: number }> {
  const res = await deps.exec("launchctl", ["print", `${domain(deps)}/${item.label}`]);
  if (res.code !== 0) return { loaded: false };
  const pid = Number(res.stdout.match(/^\s*pid = (\d+)/m)?.[1]);
  const lastExit = Number(res.stdout.match(/^\s*last exit code = (-?\d+)/m)?.[1]);
  return {
    loaded: true,
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(Number.isInteger(lastExit) ? { lastExit } : {}),
  };
}
