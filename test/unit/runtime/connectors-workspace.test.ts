import { describe, expect, it } from "bun:test";
import {
  deriveConnectorDataDir,
  resolveConnectorDataDirForRef,
  serverNameFromRef,
} from "../../../src/connectors/runtime/paths.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";

describe("resolveConnectorDataDirForRef", () => {
  const workDir = "/home/user/.nimblebrain";

  it("slug comes from the persisted ref.serverName (the install-time canonical slug)", () => {
    const dir = resolveConnectorDataDirForRef(workDir, "ws_002fbb9fda6654ca", {
      url: "https://mcp.example.com/sse",
      serverName: "example-mcp",
    });
    expect(dir).toBe(`${workDir}/workspaces/ws_002fbb9fda6654ca/data/example-mcp`);
  });

  it("two workspaces with the same connector get separate directories", () => {
    const ref = { url: "https://mcp.example.com/sse", serverName: "example-mcp" };
    expect(resolveConnectorDataDirForRef(workDir, "ws_002fbb9fda6654ca", ref)).not.toBe(
      resolveConnectorDataDirForRef(workDir, "ws_006a3c0eb78706fc", ref),
    );
  });
});

describe("deriveConnectorDataDir", () => {
  it("strips scoped-package @ and replaces slash with dash", () => {
    expect(deriveConnectorDataDir("@nimblebraininc/crm")).toBe("nimblebraininc-crm");
  });

  it("passes through unscoped names", () => {
    expect(deriveConnectorDataDir("simple-connector")).toBe("simple-connector");
  });

  it("handles @scope/name pattern", () => {
    expect(deriveConnectorDataDir("@foo/tasks")).toBe("foo-tasks");
    expect(deriveConnectorDataDir("@bar/tasks")).toBe("bar-tasks");
  });

  it("replaces reverse-DNS separators", () => {
    expect(deriveConnectorDataDir("com.example/app")).toBe("com-example-app");
  });

  it("preserves capitals while replacing dots", () => {
    expect(deriveConnectorDataDir("Name.With.Capitals/app")).toBe("Name-With-Capitals-app");
  });

  it("collapses unsafe characters and duplicate dashes", () => {
    expect(deriveConnectorDataDir("/a//b @ c")).toBe("a-b-c");
  });
});

describe("serverNameFromRef", () => {
  it("returns the persisted serverName", () => {
    expect(serverNameFromRef({ url: "https://x.test/mcp", serverName: "com-x-mcp" })).toBe(
      "com-x-mcp",
    );
  });

  it("returns null for a row that names no server", () => {
    // A hand-edited or malformed row may carry no serverName. Null makes the
    // compiler name every reader, so each skips the row instead of throwing.
    for (const row of [
      { url: "https://mcp.example.com/echo" },
      { url: "https://mcp.example.com/echo", serverName: "" },
      { name: "@acme/echo" },
    ]) {
      expect(serverNameFromRef(row as unknown as ConnectorRef)).toBeNull();
    }
  });

  it("names a row with an explicit serverName even when its url is unusable", () => {
    // Identity, not reachability: such a row cannot be connected to, but every
    // lookup keyed on its name must still resolve it (uninstall, grant lists).
    expect(serverNameFromRef({ url: "", serverName: "acme-echo" })).toBe("acme-echo");
  });
});
