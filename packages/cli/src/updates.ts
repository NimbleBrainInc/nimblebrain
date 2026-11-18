import { join } from "node:path";
import type { Deps } from "./deps.ts";
import { compareVersions, newestRuntime } from "./release.ts";
import { doNotTrack } from "./telemetry.ts";

/**
 * Whether a newer CLI or runtime exists, so a person or an agent hears about
 * it without asking. One lookup at most every 24 hours, kept in a small file;
 * it starts when a command starts and is never waited on for long: a person's
 * run waits at most `NOTICE_WAIT_MS` after its answer for a lookup still
 * running, and a `--json` run not at all. A slow or failed lookup changes
 * nothing and leaves the old answer. It only tells: nothing here updates
 * anything.
 */

const NPM_LATEST = "https://registry.npmjs.org/nimblebrain/latest";
const FRESH_MS = 24 * 60 * 60_000;
const LOOKUP_TIMEOUT_MS = 5_000;
/** How long a person's run waits, after its own answer, for a lookup still running. */
export const NOTICE_WAIT_MS = 1_000;

const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** What the last lookup found, and when it ran (ms since the epoch). */
export interface Known {
  checked_at: number;
  /** The CLI's npm `latest`. */
  cli?: string;
  /** The newest runtime release tag, `vX.Y.Z`. */
  runtime?: string;
}

/** What `updates` in a JSON answer carries: each side the last lookup knows. */
export interface Updates {
  cli?: { current: string; latest: string };
  runtime?: { current: string; latest: string };
}

/**
 * The cache sits in the per-user cache folder, not in an install's home:
 * what it holds (the newest CLI and runtime) is a fact about the world, not
 * about one install, so every `--home` shares one lookup a day, and a home
 * keeps only the files `init` wrote, which `uninstall` and `NOT_OURS` rely on.
 */
export function cachePath(deps: Deps): string {
  const xdg = deps.env.XDG_CACHE_HOME?.trim();
  const base = xdg?.startsWith("/") ? xdg : join(deps.home, ".cache");
  return join(base, "nimblebrain", "update-check.json");
}

/** Off in CI, when asked (`NIMBLEBRAIN_NO_UPDATE_CHECK=1`), and under `DO_NOT_TRACK=1`. */
export function updateCheckOff(deps: Deps): boolean {
  const ci = deps.env.CI?.trim().toLowerCase();
  return (
    (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") ||
    deps.env.NIMBLEBRAIN_NO_UPDATE_CHECK === "1" ||
    doNotTrack(deps)
  );
}

export interface UpdateCheck {
  /**
   * What is known once the command has answered: the cache, or a lookup that
   * finished within `waitMs` (0 waits for nothing). Never rejects.
   */
  known(waitMs: number): Promise<Known | undefined>;
}

/** Reads the cache and, when it is older than a day or missing, starts a lookup. Undefined when the check is off. */
export function startUpdateCheck(deps: Deps): UpdateCheck | undefined {
  if (updateCheckOff(deps)) return undefined;
  const cached = readCache(deps);
  let settled = false;
  const refreshed = cached.then(async (old) => {
    if (old && Date.now() - old.checked_at < FRESH_MS) return old;
    return (await lookup(deps, old)) ?? old;
  });
  void refreshed.then(() => {
    settled = true;
  });
  return {
    async known(waitMs) {
      const old = await cached;
      if (settled) return refreshed;
      const deadline = waitMs > 0 ? deps.sleep(waitMs).then(() => old) : Promise.resolve(old);
      // `refreshed` first: when both have settled, the fresher answer wins.
      return Promise.race([refreshed, deadline]);
    },
  };
}

async function readCache(deps: Deps): Promise<Known | undefined> {
  try {
    const raw = JSON.parse((await deps.readText(cachePath(deps))) ?? "null") as Partial<Known>;
    if (typeof raw?.checked_at !== "number") return undefined;
    return {
      checked_at: raw.checked_at,
      cli: version(raw.cli),
      runtime: version(raw.runtime),
    };
  } catch {
    return undefined;
  }
}

/**
 * Asks npm for the CLI's `latest` and GitHub for the newest runtime release,
 * through the same lookup `init` and `update` use. Writes what it found,
 * keeping the old answer for a side that failed; finds nothing, writes nothing.
 */
async function lookup(deps: Deps, old: Known | undefined): Promise<Known | undefined> {
  try {
    const [npm, runtime] = await Promise.all([
      deps.getJson(NPM_LATEST, LOOKUP_TIMEOUT_MS),
      newestRuntime(deps, LOOKUP_TIMEOUT_MS).catch(() => undefined),
    ]);
    const cli =
      npm?.status === 200 ? version((npm.body as { version?: unknown })?.version) : undefined;
    if (!cli && !runtime) return undefined;
    const known: Known = {
      checked_at: Date.now(),
      cli: cli ?? old?.cli,
      runtime: runtime ?? old?.runtime,
    };
    await deps.writeText(cachePath(deps), `${JSON.stringify(known)}\n`);
    return known;
  } catch {
    return undefined;
  }
}

function version(value: unknown): string | undefined {
  return typeof value === "string" && SEMVER.test(value) ? value : undefined;
}

/**
 * The `updates` field: the CLI's side always, the runtime's when the answer
 * names the installed runtime. Undefined when nothing is known.
 */
export function updatesField(
  known: Known | undefined,
  cliVersion: string,
  runtimeVersion?: string,
): Updates | undefined {
  const updates: Updates = {};
  if (known?.cli) updates.cli = { current: cliVersion, latest: known.cli };
  if (known?.runtime && runtimeVersion) {
    updates.runtime = { current: runtimeVersion, latest: known.runtime.replace(/^v/, "") };
  }
  return updates.cli || updates.runtime ? updates : undefined;
}

/** A person's notices: one line for each side that is behind. */
/** `run` is how to run this CLI against the install the run acted on, so `update` reaches it. */
export function noticeLines(
  updates: Updates | undefined,
  withRuntime: boolean,
  run = "npx nimblebrain",
): string[] {
  const lines: string[] = [];
  const cli = updates?.cli;
  if (cli && compareVersions(cli.latest, cli.current) > 0) {
    lines.push(
      `nimblebrain ${cli.latest} is available (you have ${cli.current}): npx nimblebrain@latest`,
    );
  }
  const rt = updates?.runtime;
  if (withRuntime && rt && compareVersions(rt.latest, rt.current) > 0) {
    lines.push(
      `NimbleBrain v${rt.latest} is available (you have v${rt.current}): ${run} update`,
    );
  }
  return lines;
}
