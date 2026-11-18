import type { Deps } from "./deps.ts";
import { CliError } from "./result.ts";

const TAGS_URL = "https://api.github.com/repos/NimbleBrainInc/nimblebrain/tags?per_page=100";

/** A release tag: `vX.Y.Z`, optionally with a pre-release such as `-rc.1`. */
const VERSION = /^v\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * The oldest runtime release this CLI can install: the first that publishes
 * `linux/arm64` images and reads the web port from `NIMBLEBRAIN_WEB_PORT` in
 * its Compose file. Raise it when the CLI starts to depend on something a
 * newer runtime's Compose file or API provides (ADR-0064).
 */
export const MIN_RUNTIME = "v0.73.0";

/**
 * The runtime release to install. The CLI is versioned on its own, so it does
 * not carry a runtime: `--runtime` names one, `NIMBLEBRAIN_TAG` pins one, and
 * otherwise it takes the newest plain `vX.Y.Z` release (SDK tags and
 * pre-releases do not count). Anything older than `MIN_RUNTIME` is refused
 * before a file is written.
 */
export async function runtimeTag(deps: Deps, requested?: string): Promise<string> {
  const pinned = requested ?? deps.env.NIMBLEBRAIN_TAG;
  let tag: string;
  if (pinned) {
    if (!VERSION.test(pinned)) {
      throw new CliError("USAGE", `"${pinned}" is not a runtime release tag like v1.2.3.`);
    }
    tag = pinned;
  } else {
    tag = await newestRuntime(deps);
  }
  if (compareVersions(tag, MIN_RUNTIME) < 0) {
    throw new CliError(
      "RUNTIME_UNSUPPORTED",
      `This CLI installs NimbleBrain ${MIN_RUNTIME} or newer, not ${tag}.`,
    );
  }
  return tag;
}

async function newestRuntime(deps: Deps): Promise<string> {
  const res = await deps.getJson(TAGS_URL, 10_000);
  const names = Array.isArray(res?.body)
    ? (res.body as Array<{ name?: unknown }>)
        .map((t) => t.name)
        .filter((n): n is string => typeof n === "string")
    : [];
  const newest = newestRelease(names);
  if (!newest) throw new CliError("NETWORK", "Could not find the newest NimbleBrain release.");
  return newest;
}

export function newestRelease(tags: string[]): string | undefined {
  const plain = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  return plain.sort(compareVersions).pop();
}

/**
 * SemVer precedence: the numbers first, then a pre-release sorts before its
 * release, and pre-release identifiers compare numerically when both are
 * numbers and as text otherwise (a number before text).
 */
export function compareVersions(a: string, b: string): number {
  const [coreA = "", preA] = a.replace(/^v/, "").split(/-(.*)/s);
  const [coreB = "", preB] = b.replace(/^v/, "").split(/-(.*)/s);
  const core = compareIdentifiers(coreA.split("."), coreB.split("."));
  if (core !== 0 || (!preA && !preB)) return core;
  if (!preA || !preB) return preA ? -1 : 1;
  return compareIdentifiers(preA.split("."), preB.split("."));
}

/** Dot-separated identifiers, left to right; when one list is a prefix of the other, the shorter is lower. */
function compareIdentifiers(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareIdentifier(a[i] ?? "", b[i] ?? "");
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function compareIdentifier(x: string, y: string): number {
  if (x === y) return 0;
  const xn = /^\d+$/.test(x);
  const yn = /^\d+$/.test(y);
  if (xn && yn) return Number(x) - Number(y);
  if (xn !== yn) return xn ? -1 : 1;
  return x < y ? -1 : 1;
}
