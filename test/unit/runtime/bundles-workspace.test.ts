import { describe, expect, it } from "bun:test";
import { deriveBundleDataDir, resolveBundleDataDirForRef } from "../../../src/bundles/paths.ts";

describe("resolveBundleDataDirForRef", () => {
  const workDir = "/home/user/.nimblebrain";

  it("slug comes from the persisted ref.serverName (the install-time canonical slug)", () => {
    const dir = resolveBundleDataDirForRef(workDir, "ws_eng", {
      url: "https://mcp.example.com/sse",
      serverName: "example-mcp",
    });
    expect(dir).toBe(`${workDir}/workspaces/ws_eng/data/example-mcp`);
  });

  it("without serverName: falls back to deriving the slug from the URL", () => {
    const dir = resolveBundleDataDirForRef(workDir, "ws_eng", {
      url: "https://mcp.example.com/sse",
    });
    expect(dir.startsWith(`${workDir}/workspaces/ws_eng/data/`)).toBe(true);
  });

  it("two workspaces with the same connector get separate directories", () => {
    const ref = { url: "https://mcp.example.com/sse", serverName: "example-mcp" };
    expect(resolveBundleDataDirForRef(workDir, "ws_eng", ref)).not.toBe(
      resolveBundleDataDirForRef(workDir, "ws_sales", ref),
    );
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
