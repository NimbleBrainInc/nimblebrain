import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import type { ToolResult } from "../../../src/engine/types.ts";
import type {
  InstalledPluginRecord,
  PluginOwner,
  PluginRecordStore,
} from "../../../src/plugins/installed/record.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../../src/tools/core-source.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import type { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";
import { stub } from "../../helpers/stub.ts";

// The conversation_starters core tool handler, driven end to end: the
// workspace it reads connectors and installed-plugin records for, and the
// structured result it returns. It reads no catalog: any fetch fails the test.

const WS = "ws_00c5a7e1b3f2d491";
const STARTERS = [{ title: "Summarize my unread email", text: "Summarize my unread email." }];

const gmail: ConnectorRef = {
  url: "https://gmail.example/mcp",
  serverName: "com-google-gmail",
  installedBy: "gmail@nimblebrain",
};

const gmailRecord: InstalledPluginRecord = {
  address: "gmail@nimblebrain",
  digest: `sha256:${"d".repeat(64)}`,
  type: "application/agent-plugins+zip",
  installedAt: "2026-11-27T00:00:00.000Z",
  connectors: [
    {
      key: "gmail",
      name: "com.google/gmail",
      server: { name: "com.google/gmail", version: "1.0.0", description: "Gmail" },
    },
  ],
  skills: [],
  starters: STARTERS,
};

const originalFetch = globalThis.fetch;
let fetched: string[];

beforeEach(() => {
  fetched = [];
  globalThis.fetch = fakeFetch(async (input) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error("no fetch expected");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function runtimeFor(opts: { wsId?: string; asked: string[] }): Runtime {
  return stub<Runtime>({
    requireWorkspaceId: () => {
      if (!opts.wsId) throw new Error("No workspace context");
      return opts.wsId;
    },
    getWorkspaceStore: () =>
      stub<WorkspaceStore>({
        get: async (id: string) => {
          opts.asked.push(id);
          return id === WS ? stub<Workspace>({ connectors: [gmail] }) : null;
        },
      }),
    getPluginRecords: () =>
      stub<PluginRecordStore>({
        list: async (owner: PluginOwner) =>
          owner.kind === "workspace" && owner.wsId === WS ? [gmailRecord] : [],
      }),
  });
}

function handler(rt: Runtime): (input: Record<string, unknown>) => Promise<ToolResult> {
  const tool = createCoreToolDefs(rt).find((d) => d.name === "conversation_starters");
  if (!tool) throw new Error("conversation_starters not registered");
  return tool.handler;
}

describe("conversation_starters tool handler", () => {
  it("returns the starters of the calling workspace's plugins, from their records", async () => {
    const asked: string[] = [];
    const res = await handler(runtimeFor({ wsId: WS, asked }))({});
    expect(res.isError).toBe(false);
    expect(asked).toEqual([WS]);
    expect(res.structuredContent).toEqual({
      conversationStarters: [{ serverName: "com-google-gmail", plugin: "gmail", ...STARTERS[0]! }],
    });
    const first = res.content[0];
    expect(first?.type === "text" ? first.text : "").toBe("Summarize my unread email (gmail)");
    expect(fetched).toEqual([]);
  });

  it("rejects without a workspace and reads no workspace", async () => {
    const asked: string[] = [];
    await expect(handler(runtimeFor({ asked }))({})).rejects.toThrow("No workspace context");
    expect(asked).toEqual([]);
  });
});
