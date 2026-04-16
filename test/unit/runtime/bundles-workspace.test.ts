import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { deriveBundleDataDir, resolveBundleDataDir } from "../../../src/bundles/paths.ts";

describe("resolveBundleDataDir", () => {
  it("combines workspace path with derived bundle data dir", () => {
    const result = resolveBundleDataDir("workspaces/ws_eng", "@nimblebraininc/crm");
    expect(result).toBe(join("workspaces/ws_eng", "data", "nimblebraininc-crm"));
  });

  it("two workspaces with the same bundle get separate directories", () => {
    const ws1 = resolveBundleDataDir("/home/user/.nimblebrain/workspaces/ws_eng", "@nimblebraininc/crm");
    const ws2 = resolveBundleDataDir("/home/user/.nimblebrain/workspaces/ws_sales", "@nimblebraininc/crm");
    expect(ws1).not.toBe(ws2);
    expect(ws1).toBe("/home/user/.nimblebrain/workspaces/ws_eng/data/nimblebraininc-crm");
    expect(ws2).toBe("/home/user/.nimblebrain/workspaces/ws_sales/data/nimblebraininc-crm");
  });

  it("handles unscoped bundle names", () => {
    const result = resolveBundleDataDir("/workspaces/default", "simple-bundle");
    expect(result).toBe("/workspaces/default/data/simple-bundle");
  });

  it("handles absolute workspace paths", () => {
    const result = resolveBundleDataDir("/home/user/.nimblebrain/workspaces/ws_abc", "@acme/tasks");
    expect(result).toBe("/home/user/.nimblebrain/workspaces/ws_abc/data/acme-tasks");
  });

  it("default workspace resolves correctly for backward compat", () => {
    // Default workspace path is simply the workDir itself
    const workDir = "/home/user/.nimblebrain";
    const result = resolveBundleDataDir(workDir, "@nimblebraininc/crm");
    expect(result).toBe(join(workDir, "data", "nimblebraininc-crm"));
  });
});

describe("deriveBundleDataDir (unchanged)", () => {
  it("strips @ and replaces / with -", () => {
    expect(deriveBundleDataDir("@nimblebraininc/crm")).toBe("nimblebraininc-crm");
  });

  it("passes through unscoped names", () => {
    expect(deriveBundleDataDir("simple-bundle")).toBe("simple-bundle");
  });

  it("handles @scope/name pattern", () => {
    expect(deriveBundleDataDir("@foo/tasks")).toBe("foo-tasks");
    expect(deriveBundleDataDir("@bar/tasks")).toBe("bar-tasks");
  });
});
