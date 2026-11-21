import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorCatalog } from "../../../src/connectors/catalog/catalog.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import type { ToolResult } from "../../../src/engine/types.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../../src/tools/core-source.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import type { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import {
  buildCatalog,
  type FixtureCatalog,
  TEST_CATALOG_URL,
} from "../../helpers/plugin-catalog.ts";
import { stub } from "../../helpers/stub.ts";

// The conversation_starters core tool handler, driven end to end: the
// workspace it reads connectors for, the pinned catalog it reads starters
// from (served from memory through fetch), and the structured result it returns.

const WS = "ws_00c5a7e1b3f2d491";
const STARTERS = [{ title: "Summarize my unread email", text: "Summarize my unread email." }];

const gmail: ConnectorRef = {
  url: "https://gmail.example/mcp",
  serverName: "gmail",
  skillsLock: [
    {
      plugin: "gmail@nimblebrain",
      server: "com.google/gmail",
      skill: "gmail",
      version: "c".repeat(64),
      digest: "d".repeat(64),
      sha: "s",
    },
  ],
};

let workDir: string;
let catalog: FixtureCatalog;
const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env.NB_PLUGIN_CATALOG_URL,
  sha: process.env.NB_PLUGIN_CATALOG_SHA256,
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "starters-tool-"));
  catalog = buildCatalog([
    { name: "gmail", servers: { gmail: "com.google/gmail" }, conversationStarters: STARTERS },
  ]);
  globalThis.fetch = catalog.fetch;
  process.env.NB_PLUGIN_CATALOG_URL = TEST_CATALOG_URL;
  process.env.NB_PLUGIN_CATALOG_SHA256 = catalog.pin;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [
    ["NB_PLUGIN_CATALOG_URL", originalEnv.url],
    ["NB_PLUGIN_CATALOG_SHA256", originalEnv.sha],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workDir, { recursive: true, force: true });
});

function runtimeFor(opts: { wsId?: string; asked: string[] }): Runtime {
  return stub<Runtime>({
    requireWorkspaceId: () => {
      if (!opts.wsId) throw new Error("No workspace context");
      return opts.wsId;
    },
    getWorkDir: () => workDir,
    getConnectorCatalog: () =>
      stub<ConnectorCatalog>({
        catalogByIdMap: async () => new Map(),
        catalogByUrl: async () => new Map(),
      }),
    getWorkspaceStore: () =>
      stub<WorkspaceStore>({
        get: async (id: string) => {
          opts.asked.push(id);
          return id === WS ? stub<Workspace>({ connectors: [gmail] }) : null;
        },
      }),
  });
}

function handler(rt: Runtime): (input: Record<string, unknown>) => Promise<ToolResult> {
  const tool = createCoreToolDefs(rt).find((d) => d.name === "conversation_starters");
  if (!tool) throw new Error("conversation_starters not registered");
  return tool.handler;
}

describe("conversation_starters tool handler", () => {
  it("returns the starters of the calling workspace's plugins", async () => {
    const asked: string[] = [];
    const res = await handler(runtimeFor({ wsId: WS, asked }))({});
    expect(res.isError).toBe(false);
    expect(asked).toEqual([WS]);
    expect(res.structuredContent).toEqual({
      conversationStarters: [{ serverName: "gmail", plugin: "gmail", ...STARTERS[0]! }],
    });
    const first = res.content[0];
    expect(first?.type === "text" ? first.text : "").toBe("Summarize my unread email (gmail)");
  });

  it("rejects without a workspace and reads no workspace", async () => {
    const asked: string[] = [];
    await expect(handler(runtimeFor({ asked }))({})).rejects.toThrow("No workspace context");
    expect(asked).toEqual([]);
  });
});
