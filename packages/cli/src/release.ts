import type { Deps } from "./deps.ts";
import { CliError } from "./result.ts";

const TAGS_URL = "https://api.github.com/repos/NimbleBrainInc/nimblebrain/tags?per_page=100";

/**
 * The runtime release this CLI installs: its own version, because a CLI
 * release and a runtime release share one tag. `NIMBLEBRAIN_TAG` overrides it.
 * A development build (`0.0.0-dev`) has no release of its own, so it takes the
 * newest plain `vX.Y.Z` tag; SDK tags and pre-releases do not count.
 */
export async function releaseTag(deps: Deps, version: string): Promise<string> {
  const pinned = deps.env.NIMBLEBRAIN_TAG;
  if (pinned) return pinned;
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

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
