/**
 * Tests for `scripts/lib/dev-prepare.ts` — the fresh-checkout preparation the
 * shared dev launcher runs.
 *
 * The selection predicate is the part worth locking. If the bundle-UI layout
 * ever moves, `bundleUisMissingDist` quietly returns `[]`, nothing is built,
 * and the "UI not built" fallback comes back with no error and no log line —
 * silently undoing the only thing this module exists to do. The equivalent
 * breakage in `build:bundles` fails loudly through `test:bundles`; this one
 * has no such alarm, which is why it gets one here.
 *
 * `installIfMissing`'s guards are pure `existsSync` checks that return before
 * any subprocess spawns, so they are exercised the same way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleUisMissingDist, installIfMissing } from "../../../scripts/lib/dev-prepare.ts";

let repoRoot: string;

/** Build a bundle dir the way the repo lays them out. */
function makeBundle(name: string, opts: { ui?: boolean; dist?: boolean } = {}) {
  const ui = join(repoRoot, "src", "bundles", name, "ui");
  mkdirSync(ui, { recursive: true });
  if (opts.ui !== false) writeFileSync(join(ui, "package.json"), "{}");
  if (opts.dist) {
    mkdirSync(join(ui, "dist"), { recursive: true });
    writeFileSync(join(ui, "dist", "index.html"), "<!doctype html>");
  }
  return ui;
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "nb-prepare-test-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("bundleUisMissingDist", () => {
  test("selects a bundle UI with no dist/index.html", () => {
    makeBundle("home");
    expect(bundleUisMissingDist(repoRoot).map((b) => b.name)).toEqual(["home"]);
  });

  test("skips a bundle UI that already has a built dist", () => {
    makeBundle("home", { dist: true });
    expect(bundleUisMissingDist(repoRoot)).toEqual([]);
  });

  test("skips a bundle directory with no ui/package.json", () => {
    // `schemas` is real: a bundle dir with no UI at all. It must never be built.
    makeBundle("schemas", { ui: false });
    expect(bundleUisMissingDist(repoRoot)).toEqual([]);
  });

  test("selects only the unbuilt ones from a mixed tree", () => {
    makeBundle("home", { dist: true });
    makeBundle("usage");
    makeBundle("files");
    makeBundle("schemas", { ui: false });
    expect(bundleUisMissingDist(repoRoot).map((b) => b.name).sort()).toEqual(["files", "usage"]);
  });

  test("returns [] when src/bundles does not exist rather than throwing", () => {
    expect(bundleUisMissingDist(repoRoot)).toEqual([]);
  });

  test("the returned ui path is the directory a build would run in", () => {
    const ui = makeBundle("home");
    expect(bundleUisMissingDist(repoRoot)[0]?.ui).toBe(ui);
  });

  test("dist/ alone is not enough — index.html is the sentinel the runtime resolves", () => {
    const ui = makeBundle("home");
    mkdirSync(join(ui, "dist"), { recursive: true });
    expect(bundleUisMissingDist(repoRoot).map((b) => b.name)).toEqual(["home"]);
  });
});

describe("installIfMissing", () => {
  test("no-ops for a directory with no package.json", () => {
    // Returns before spawning; a spawn here would fail the test by timing out
    // or by erroring on a directory that is not a package.
    expect(() => installIfMissing("nothing", join(repoRoot, "absent"))).not.toThrow();
  });

  test("no-ops when node_modules is already present", () => {
    const dir = join(repoRoot, "web");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    expect(() => installIfMissing("web", dir)).not.toThrow();
  });
});
