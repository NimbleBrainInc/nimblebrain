import { describe, expect, it } from "bun:test";
import type { ConnectorCatalogEntry } from "../../../src/connectors/catalog/types.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import {
  type WorkspaceConversationStartersDeps,
  workspaceConversationStarters,
} from "../../../src/services/workspace-conversation-starters.ts";
import type { ServerConversationStarters } from "../../../src/skills/connector-skill-resolver.ts";
import { stub } from "../../helpers/stub.ts";

const WS = "ws_000f7ed6658f9d30";

function ref(serverName: string, url: string, lockedServer?: string): ConnectorRef {
  return {
    url,
    serverName,
    ...(lockedServer
      ? {
          skillsLock: [
            {
              plugin: "gmail@nimblebrain",
              server: lockedServer,
              skill: "gmail",
              version: "c".repeat(64),
              digest: "d".repeat(64),
              sha: "s",
            },
          ],
        }
      : {}),
  };
}

function entries(byKey: Record<string, string>): Map<string, ConnectorCatalogEntry> {
  return new Map(
    Object.entries(byKey).map(([key, id]) => [key, stub<ConnectorCatalogEntry>({ id })]),
  );
}

const GMAIL: ServerConversationStarters = {
  server: "com.google/gmail",
  plugin: "gmail",
  conversationStarters: [{ title: "Summarize my unread email", text: "Summarize it." }],
};
const LINEAR: ServerConversationStarters = {
  server: "app.linear/mcp",
  plugin: "linear",
  conversationStarters: [{ title: "What's due?", text: "List my issues." }],
};

function deps(
  over: Partial<WorkspaceConversationStartersDeps> & { asked?: string[][] } = {},
): WorkspaceConversationStartersDeps & { asked: string[][] } {
  const asked = over.asked ?? [];
  return {
    connectors: over.connectors ?? (async () => []),
    catalogByIdMap: over.catalogByIdMap ?? (async () => new Map()),
    catalogByUrl: over.catalogByUrl ?? (async () => new Map()),
    resolveConversationStarters:
      over.resolveConversationStarters ??
      (async (servers) => {
        asked.push([...servers]);
        return [GMAIL, LINEAR].filter((s) => servers.includes(s.server));
      }),
    asked,
  };
}

describe("workspaceConversationStarters", () => {
  it("gives each installed plugin's starters under this workspace's server name", async () => {
    const d = deps({
      connectors: async () => [
        ref("gmail", "https://gmail.example/mcp", "com.google/gmail"),
        ref("linear", "https://mcp.linear.app/mcp"),
      ],
      catalogByUrl: async () => entries({ "https://mcp.linear.app/mcp": "app.linear/mcp" }),
    });
    expect(await workspaceConversationStarters(WS, d)).toEqual([
      {
        serverName: "gmail",
        plugin: "gmail",
        title: "Summarize my unread email",
        text: "Summarize it.",
      },
      { serverName: "linear", plugin: "linear", title: "What's due?", text: "List my issues." },
    ]);
  });

  it("reads the catalog only when some connector's lock records no registry name", async () => {
    let catalogReads = 0;
    const d = deps({
      connectors: async () => [ref("gmail", "https://gmail.example/mcp", "com.google/gmail")],
      catalogByUrl: async () => {
        catalogReads++;
        return new Map();
      },
    });
    await workspaceConversationStarters(WS, d);
    expect(catalogReads).toBe(0);
  });

  it("asks for nothing when no connector maps to a catalog server", async () => {
    const d = deps({ connectors: async () => [ref("custom", "https://custom.example/mcp")] });
    expect(await workspaceConversationStarters(WS, d)).toEqual([]);
    expect(d.asked).toEqual([]);
  });

  it("skips a row it cannot use", async () => {
    const d = deps({
      connectors: async () => [stub<ConnectorRef>({ serverName: "", url: "https://x.example" })],
    });
    expect(await workspaceConversationStarters(WS, d)).toEqual([]);
  });

  it("gives none, never an error, when the catalog cannot be read", async () => {
    const d = deps({
      connectors: async () => [ref("gmail", "https://gmail.example/mcp", "com.google/gmail")],
      resolveConversationStarters: async () => {
        throw new Error("plugin catalog fetch failed: HTTP 503");
      },
    });
    expect(await workspaceConversationStarters(WS, d)).toEqual([]);
  });
});
