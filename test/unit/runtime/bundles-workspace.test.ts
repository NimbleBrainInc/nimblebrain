import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBundleDataDir, resolveBundleDataDirForRef } from "../../../src/bundles/paths.ts";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeBundleDir(manifestName: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nb-bundle-fixture-"));
  tmpRoots.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: manifestName, version: "0.0.0" }));
  return dir;
}

describe("resolveBundleDataDirForRef", () => {
  const workDir = "/home/user/.nimblebrain";

  it("named ref: slug from ref.name (which is the canonical manifest name)", () => {
    const dir = resolveBundleDataDirForRef(workDir, "ws_eng", { name: "@nimblebraininc/crm" });
    expect(dir).toBe(`${workDir}/workspaces/ws_eng/data/nimblebraininc-crm`);
  });

  it("path ref: slug from manifest.name on disk, NOT from the path string", () => {
    const bundleDir = makeBundleDir("@nimblebraininc/synapse-crm");
    const dir = resolveBundleDataDirForRef(workDir, "ws_mat", { path: bundleDir });
    expect(dir).toBe(`${workDir}/workspaces/ws_mat/data/nimblebraininc-synapse-crm`);
  });

  it(
    "regression: a path ref and a name ref for the SAME bundle produce the SAME slug " +
      "(this is the contract that keeps the launch-write path aligned with the seedInstance / " +
      "briefing-read path; before this it diverged because the launch path slugified the " +
      "filesystem path while the reader slugified the manifest name)",
    () => {
      const bundleDir = makeBundleDir("@nimblebraininc/synapse-crm");
      const fromPath = resolveBundleDataDirForRef(workDir, "ws_mat", { path: bundleDir });
      const fromName = resolveBundleDataDirForRef(workDir, "ws_mat", {
        name: "@nimblebraininc/synapse-crm",
      });
      expect(fromPath).toBe(fromName);
    },
  );

  it("url ref: slug from persisted ref.serverName (the install-time canonical slug)", () => {
    const dir = resolveBundleDataDirForRef(workDir, "ws_eng", {
      url: "https://mcp.example.com/sse",
      serverName: "example-mcp",
    });
    expect(dir).toBe(`${workDir}/workspaces/ws_eng/data/example-mcp`);
  });

  it("url ref without serverName: falls back to deriving the slug from the URL", () => {
    const dir = resolveBundleDataDirForRef(workDir, "ws_eng", { url: "https://mcp.example.com/sse" });
    expect(dir.startsWith(`${workDir}/workspaces/ws_eng/data/`)).toBe(true);
  });

  it("two workspaces with the same bundle get separate directories", () => {
    const ws1 = resolveBundleDataDirForRef(workDir, "ws_eng", { name: "@nimblebraininc/crm" });
    const ws2 = resolveBundleDataDirForRef(workDir, "ws_sales", { name: "@nimblebraininc/crm" });
    expect(ws1).not.toBe(ws2);
  });

  it("path ref with a broken manifest: falls back to path-derived slug + warn (bundle will fail to start anyway)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-bundle-fixture-broken-"));
    tmpRoots.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{ not valid json");
    const out = resolveBundleDataDirForRef(workDir, "ws_eng", { path: dir });
    // Fallback slug is path-derived — the exact form doesn't matter for callers, only that
    // it's a string (not a throw) so inventory build proceeds.
    expect(out.startsWith(`${workDir}/workspaces/ws_eng/data/`)).toBe(true);
  });
});

describe("deriveBundleDataDir", () => {
  it("strips scoped-package @ and replaces slash with dash", () => {
    expect(deriveBundleDataDir("@nimblebraininc/crm")).toBe("nimblebraininc-crm");
  });

  it("passes through unscoped names", () => {
    expect(deriveBundleDataDir("simple-bundle")).toBe("simple-bundle");
  });

  it("handles @scope/name pattern", () => {
    expect(deriveBundleDataDir("@foo/tasks")).toBe("foo-tasks");
    expect(deriveBundleDataDir("@bar/tasks")).toBe("bar-tasks");
  });

  it("collapses absolute path bundle refs into one directory segment", () => {
    expect(deriveBundleDataDir("/abs/path/with/slashes")).toBe("abs-path-with-slashes");
  });

  it("replaces reverse-DNS separators", () => {
    expect(deriveBundleDataDir("com.example/app")).toBe("com-example-app");
  });

  it("preserves capitals while replacing dots", () => {
    expect(deriveBundleDataDir("Name.With.Capitals/app")).toBe("Name-With-Capitals-app");
  });

  it("collapses unsafe characters and duplicate dashes", () => {
    expect(deriveBundleDataDir("/a//b @ c")).toBe("a-b-c");
  });
});
