import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A newly published version waits 14 days before it can reach this repo. The
// package managers enforce that window, because they pick the versions: a
// Renovate lock file refresh regenerates every lock with `bun install` or
// `uv lock`, and Renovate's own check cannot judge a refresh. So every
// directory that owns a lock file must carry the window itself — bunfig.toml
// is not resolved up the tree — and it must be the window Renovate applies to
// its dependency PRs.

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const DAY_SECONDS = 24 * 60 * 60;

const renovateDays = Number(
  /^(\d+) days$/.exec(JSON.parse(read("renovate.json")).minimumReleaseAge)?.[1],
);

const lockDirs = (name: string) =>
  Bun.spawnSync(["git", "ls-files", `*${name}`, name], { cwd: root })
    .stdout.toString()
    .split("\n")
    .filter((path) => path.endsWith(name))
    .map((path) => dirname(path));

describe("every lock file is resolved under Renovate's release-age window", () => {
  test("Renovate names a window in days", () => {
    expect(renovateDays).toBeGreaterThan(0);
  });

  const bunDirs = lockDirs("bun.lock");
  test("there are bun lock files to check", () => {
    expect(bunDirs.length).toBeGreaterThan(0);
  });
  for (const dir of bunDirs) {
    test(`${dir}/bunfig.toml holds new versions for the window`, () => {
      const path = join(dir, "bunfig.toml");
      expect(existsSync(join(root, path))).toBe(true);
      const config = Bun.TOML.parse(read(path)) as { install?: { minimumReleaseAge?: number } };
      expect(config.install?.minimumReleaseAge).toBe(renovateDays * DAY_SECONDS);
    });
  }

  for (const dir of lockDirs("uv.lock")) {
    test(`${dir}/uv.toml holds new versions for the window`, () => {
      const path = join(dir, "uv.toml");
      expect(existsSync(join(root, path))).toBe(true);
      const config = Bun.TOML.parse(read(path)) as { "exclude-newer"?: string };
      expect(config["exclude-newer"]).toBe(`${renovateDays} days`);
    });
  }
});
