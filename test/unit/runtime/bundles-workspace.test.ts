import { describe, expect, it } from "bun:test";
import {
  deriveBundleDataDir,
  resolveBundleDataDirForRef,
  serverNameFromRef,
} from "../../../src/bundles/paths.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";

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

describe("serverNameFromRef", () => {
  it("returns the persisted serverName when the ref carries one", () => {
    expect(serverNameFromRef({ url: "https://x.test/mcp", serverName: "com-x-mcp" })).toBe(
      "com-x-mcp",
    );
  });

  it("derives from the url when the ref predates serverName persistence", () => {
    expect(serverNameFromRef({ url: "https://mcp.example.com/echo" })).toBe("echo");
  });

  it("returns null for a row this build can neither name nor reach", () => {
    // Disk holds rows the current type no longer describes. Returning a string
    // meant `deriveServerName(undefined)` threw a bare TypeError out of
    // whichever reader touched the row first — a webhook delivery, a personal
    // connector listing, boot. Null makes the compiler name those readers.
    for (const row of [
      { name: "@acme/echo" },
      { path: "/srv/echo" },
      { url: "" },
      { url: "   " },
      { url: "..." },
      { url: "ftp://x.test/mcp" },
    ]) {
      expect(serverNameFromRef(row as unknown as BundleRef)).toBeNull();
    }
  });

  it("still names a legacy row that carries an explicit serverName", () => {
    // Identity, not reachability: such a row cannot be connected to, but every
    // lookup keyed on its name must still resolve it (uninstall, grant lists).
    expect(
      serverNameFromRef({ name: "@acme/echo", serverName: "acme-echo" } as unknown as BundleRef),
    ).toBe("acme-echo");
  });
});
