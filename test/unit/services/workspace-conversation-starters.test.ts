/**
 * Workspace conversation starters come from the installed-plugin records
 * (ADR-0077): each record's starters, under the first of its connections the
 * workspace has. Nothing reads a catalog or opens an archive.
 */

import { describe, expect, it } from "bun:test";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import type { InstalledPluginRecord } from "../../../src/plugins/installed/record.ts";
import { workspaceConversationStarters } from "../../../src/services/workspace-conversation-starters.ts";

const WS = "ws_000f7ed6658f9d30";

function ref(serverName: string): ConnectorRef {
  return { url: `https://${serverName}.example.test/mcp`, serverName };
}

function record(
  address: string,
  names: string[],
  starters: Array<{ title: string; text: string }>,
): InstalledPluginRecord {
  return {
    address,
    digest: `sha256:${"a".repeat(64)}`,
    type: "application/agent-plugins+zip",
    installedAt: "2026-11-27T00:00:00.000Z",
    connectors: names.map((name) => ({
      key: name,
      name,
      server: { name, version: "1.0.0", description: name },
    })),
    skills: [],
    starters,
  };
}

const GMAIL = record(
  "gmail@nimblebrain",
  ["com.google/gmail"],
  [{ title: "Summarize my unread email", text: "Summarize it." }],
);
const LINEAR = record(
  "linear@nimblebrain",
  ["app.linear/mcp"],
  [{ title: "What's due?", text: "List my issues." }],
);

describe("workspaceConversationStarters", () => {
  it("gives each installed plugin's starters under this workspace's server name", async () => {
    const out = await workspaceConversationStarters(WS, {
      connectors: async () => [ref("com-google-gmail"), ref("app-linear-mcp")],
      records: async () => [GMAIL, LINEAR],
    });
    expect(out).toEqual([
      {
        serverName: "com-google-gmail",
        plugin: "gmail",
        title: "Summarize my unread email",
        text: "Summarize it.",
      },
      {
        serverName: "app-linear-mcp",
        plugin: "linear",
        title: "What's due?",
        text: "List my issues.",
      },
    ]);
  });

  it("gives a connector no record names no starters", async () => {
    const out = await workspaceConversationStarters(WS, {
      connectors: async () => [ref("com-google-gmail"), ref("hand-added")],
      records: async () => [],
    });
    expect(out).toEqual([]);
  });

  it("gives a plugin with no connection here none, and a multi-server plugin its starters once", async () => {
    const suite = record("suite@x", ["com.a/mcp", "com.b/mcp"], [{ title: "Go", text: "Go." }]);
    const out = await workspaceConversationStarters(WS, {
      connectors: async () => [ref("com-b-mcp"), ref("com-a-mcp")],
      records: async () => [suite, GMAIL],
    });
    expect(out).toEqual([{ serverName: "com-a-mcp", plugin: "suite", title: "Go", text: "Go." }]);
  });

  it("gives none rather than an error when the records cannot be read", async () => {
    const out = await workspaceConversationStarters(WS, {
      connectors: async () => [ref("com-google-gmail")],
      records: async () => {
        throw new Error("disk");
      },
    });
    expect(out).toEqual([]);
  });
});
