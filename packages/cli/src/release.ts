import type { Deps } from "./deps.ts";
import { CliError } from "./result.ts";

const TAGS_URL = "https://api.github.com/repos/NimbleBrainInc/nimblebrain/tags?per_page=100";

/** A release tag: `vX.Y.Z`, optionally with a pre-release such as `-rc.1`. */
const VERSION = /^v\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * The runtime release this CLI installs: its own version, because a CLI
 * release and a runtime release share one tag. `NIMBLEBRAIN_TAG` overrides it.
 * A development build (`0.0.0-dev`) has no release of its own, so it takes the
 * newest plain `vX.Y.Z` tag; SDK tags and pre-releases do not count.
 */
export async function releaseTag(deps: Deps, version: string): Promise<string> {
  const pinned = deps.env.NIMBLEBRAIN_TAG;
  if (pinned) {
    if (!VERSION.test(pinned))
      throw new CliError("USAGE", `NIMBLEBRAIN_TAG "${pinned}" is not a release tag like v1.2.3.`);
    return pinned;
  }
  if (!version.startsWith("0.0.0")) return `v${version}`;
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
