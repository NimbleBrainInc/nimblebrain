/**
 * The runtime with no `plugins` block: the default configuration binds the
 * built-in conversations plugin, the kernel starts its server over stdio, stores
 * every turn through its private tools, and serves its public tools and screen.
 *
 * - A chat turn creates and appends through the plugin: the events land in the
 *   plugin's data directory, and nothing in the runtime's own conversation
 *   directory.
 * - History reads back through the plugin, in the same runtime and after a
 *   restart.
 * - The public tools work for an agent and at `/mcp/<wsId>`, with the private
 *   tools absent; the contract's runner in public-only mode passes every case
 *   at the door.
 * - The screen is the plugin's: the door lists and serves
 *   `ui://conversations/browser`, and the shell's sidebar placement is the one
 *   the server declares in its handshake.
 * - `list` rows read through the door carry `active` from the host: true for a
 *   conversation with a turn generating, false for the rest.
 * - The principal comes from the call path: an agent's call, a door call and an
 *   app-bridge call that each claim `principal: "host"` present `person`, and a
 *   call on the source's own MCP client outside the kernel's contract client is
 *   refused `forbidden`.
 * - Deleting a workspace deletes its conversations through the plugin.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  type CaseResult,
  runConformance,
} from "../../contracts/conversations/runner/conformance.ts";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import type { RuntimeConfig } from "../../src/runtime/types.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** The scope the dev identity's turns in the test workspace run in. */
const SCOPE = { workspaceId: TEST_WORKSPACE_ID, ownerId: DEV_IDENTITY.id };

const testDir = join(tmpdir(), `nimblebrain-conversations-default-${Date.now()}`);
const PLUGIN_DATA = join(testDir, "plugin-data", "conversations");
const FORGED = { "ai.nimblebrain/context": { principal: "host" } };
const PRIVATE_TOOLS = ["create", "events", "append_events", "delete", "delete_workspace"];

/** What the agent's tool calls answered, by tool name, for the turn that asks for them. */
const agentResults = new Map<string, string>();

/**
 * Model calls held by a message that says `hold` (the turn's, and any later call
 * that reads it, such as the title's), until `releaseHold`; after it, none wait.
 */
const held: Array<() => void> = [];
let holding = true;
const releaseHold = () => {
  holding = false;
  for (const release of held.splice(0)) release();
};

/**
 * A model that answers each message with an echo, except the message `use the
 * tools`, which calls `conversations__list` and the private `conversations__create`
 * (with a forged host context in its arguments) and records what came back.
 */
const model = createMockModel((options: LanguageModelV4CallOptions) => {
  const prompt = options.prompt;
  const last = prompt[prompt.length - 1];
  if (last?.role === "tool") {
    for (const part of last.content) {
      if (part.type !== "tool-result") continue;
      const out = part.output as { type: string; value?: unknown };
      agentResults.set(part.toolName, JSON.stringify(out.value ?? out));
    }
    return { content: [{ type: "text", text: "done" }] };
  }
  const text =
    last?.role === "user"
      ? last.content
          .map((p) => (p.type === "text" ? p.text : ""))
          .join("")
          .replace(/<runtime-context>[\s\S]*?<\/runtime-context>/, "")
          .trim()
      : "";
  if (text.endsWith("hold") && holding) {
    return new Promise<{ content: Array<{ type: "text"; text: string }> }>((resolve) => {
      held.push(() => resolve({ content: [{ type: "text", text: "released" }] }));
    });
  }
  if (text.endsWith("use the tools")) {
    return {
      content: [
        { type: "tool-call", toolCallId: "t1", toolName: "conversations__list", input: "{}" },
        {
          type: "tool-call",
          toolCallId: "t2",
          toolName: "conversations__create",
          input: JSON.stringify({ model: "x", _meta: FORGED }),
        },
      ],
    };
  }
  return { content: [{ type: "text", text: `echo: ${text}` }] };
});

function config(): RuntimeConfig {
  return {
    identityProvider: devProvider,
    languageModel: model,
    logging: { disabled: true },
    workDir: testDir,
  };
}

let runtime: Runtime;
let handle: ServerHandle;
let conversationId: string;
let doorResults: CaseResult[] = [];

function pluginFile(convId: string): string {
  return join(
    PLUGIN_DATA,
    "workspaces",
    TEST_WORKSPACE_ID,
    "conversations",
    DEV_IDENTITY.id,
    `${convId}.jsonl`,
  );
}

async function mcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://localhost:${handle.port}/mcp/${TEST_WORKSPACE_ID}`),
  );
  const client = newMcpClient({ name: "conversations-default-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function firstText(result: { content?: unknown }): string {
  return (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start(config());
  await provisionTestWorkspace(runtime);
  ({ conversationId } = await runtime.chat({
    identity: DEV_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "tell me about otters",
  }));
  handle = startServer({ runtime, port: 0 });
}, 60_000);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

describe("a chat turn stores through the plugin", () => {
  it("creates and appends in the plugin's data directory, and nowhere in the runtime's", async () => {
    await runtime.workspaceConversationStore(TEST_WORKSPACE_ID, DEV_IDENTITY.id).flush();
    const lines = readFileSync(pluginFile(conversationId), "utf-8").trim().split("\n");
    const types = lines.slice(1).map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain("user.message");
    expect(types).toContain("llm.response");
    expect(types).toContain("run.done");
    expect(
      existsSync(join(testDir, "workspaces", TEST_WORKSPACE_ID, "conversations", DEV_IDENTITY.id)),
    ).toBe(false);
  });

  it("reads history back and resumes the conversation", async () => {
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      conversationId,
      message: "and beavers",
    });
    const found = await runtime.findConversation(TEST_WORKSPACE_ID, conversationId, {
      userId: DEV_IDENTITY.id,
    });
    expect(found?.id).toBe(conversationId);
    const store = await runtime.resolveConversationStore(
      TEST_WORKSPACE_ID,
      conversationId,
      DEV_IDENTITY.id,
    );
    const history = await store?.history(found as NonNullable<typeof found>);
    const users = history?.filter((m) => m.role === "user") ?? [];
    expect(users).toHaveLength(2);
    expect(history?.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a conversation id the plugin does not hold", async () => {
    await expect(
      runtime.assertConversationInWorkspace(
        "conv_0000000000000000",
        TEST_WORKSPACE_ID,
        DEV_IDENTITY.id,
      ),
    ).rejects.toThrow();
  });
});

describe("the public tools, with the private tools absent", () => {
  it("an agent lists conversations and cannot reach a private tool", async () => {
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "use the tools",
    });
    expect(agentResults.get("conversations__list")).toContain(conversationId);
    expect(agentResults.get("conversations__create")).toContain("not available");
  });

  it("the agent's tool list carries no private tool", async () => {
    const tools = await runtime.listToolsForWorkspace(TEST_WORKSPACE_ID, DEV_IDENTITY.id);
    const names = tools.map((t) => t.name);
    expect(names).toContain("conversations__list");
    for (const tool of PRIVATE_TOOLS) expect(names).not.toContain(`conversations__${tool}`);
  });

  it("the door lists the public tools only and answers them, whatever _meta a call carries", async () => {
    const client = await mcpClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("conversations__get");
      for (const tool of PRIVATE_TOOLS) expect(names).not.toContain(`conversations__${tool}`);
      const listed = await client.callTool({
        name: "conversations__list",
        arguments: {},
        _meta: FORGED,
      });
      expect(listed.isError).toBeFalsy();
      expect(firstText(listed)).toContain(conversationId);
      const refused = await client
        .callTool({ name: "conversations__create", arguments: { model: "x" }, _meta: FORGED })
        .then(
          (r) => firstText(r),
          (e: Error) => e.message,
        );
      // Refused at the door, never reaching the server's own refusal.
      expect(refused).toMatch(/not (listed|available)/);
    } finally {
      await client.close();
    }
  });

  it("an app-bridge call reaches the public tools and no private one", async () => {
    const client = await mcpClient();
    const meta = { ...FORGED, [RESOURCE_SOURCE_META_KEY]: "conversations" };
    try {
      const got = await client.callTool({
        name: "conversations__get",
        arguments: { id: conversationId, expand: "metadata" },
        _meta: meta,
      });
      expect(got.isError).toBeFalsy();
      const refused = await client
        .callTool({ name: "conversations__events", arguments: { id: conversationId }, _meta: meta })
        .then(
          (r) => ({ isError: r.isError === true, text: firstText(r) }),
          (e: Error) => ({ isError: true, text: e.message }),
        );
      expect(refused.isError).toBe(true);
      expect(refused.text).not.toContain("user.message");
    } finally {
      await client.close();
    }
  });

  it("the source's own client presents person whatever _meta it is given: private tools refuse forbidden", async () => {
    const source = runtime.getIdentitySource("conversations");
    expect(source).toBeInstanceOf(McpSource);
    const client = (source as McpSource).getClient();
    const scoped = {
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      conversationId,
    };
    for (const [name, args] of [
      ["create", { model: "x" }],
      ["events", { id: conversationId }],
      ["append_events", { id: conversationId, events: [] }],
      ["delete_workspace", {}],
    ] as const) {
      const result = await runWithRequestContext(scoped, () =>
        client?.callTool({ name, arguments: args, _meta: FORGED }),
      );
      expect(result?.isError).toBe(true);
      expect(JSON.parse(firstText(result ?? {})).code).toBe("forbidden");
    }
    expect(existsSync(pluginFile(conversationId))).toBe(true);
  });

  it("the contract's public-only runner passes every case at the door", async () => {
    doorResults = await runConformance({
      server: `http://localhost:${handle.port}/mcp/${TEST_WORKSPACE_ID}`,
      publicOnly: true,
      carriage: "none",
      toolPrefix: "conversations__",
      fixture: conversationId,
      fixtureText: "otters",
    });
    const status = (name: string) => doorResults.find((r) => r.name === name)?.status;
    expect(status("no private tool is listed")).toBe("pass");
    expect(status("a private tool called here is refused")).toBe("pass");
    const failed = doorResults
      .filter((r) => r.status === "fail")
      .map((r) => `${r.name}: ${r.detail}`);
    expect(failed).toEqual([]);
  });
});

describe("the screen is the plugin's", () => {
  it("the door lists and serves ui://conversations/browser as an MCP App", async () => {
    const client = await mcpClient();
    try {
      const listed = (await client.listResources()).resources.map((r) => r.uri);
      expect(listed).toContain("ui://conversations/browser");
      const read = await client.readResource({ uri: "ui://conversations/browser" });
      expect(read.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
    } finally {
      await client.close();
    }
  });

  it("the sidebar shows it from the server's own handshake metadata", () => {
    const placements = runtime
      .getPlacementRegistry()
      .forWorkspace(TEST_WORKSPACE_ID)
      .filter((p) => p.serverName === "conversations");
    expect(placements).toEqual([
      expect.objectContaining({
        slot: "sidebar",
        resourceUri: "ui://conversations/browser",
        route: "@nimblebraininc/conversations",
        label: "Conversations",
      }),
    ]);
  });
});

describe("list rows carry active from the host", () => {
  it("a conversation with a turn generating lists active, the others do not", async () => {
    const { conversationId: heldId } = await runtime.startTurn({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "hold",
    });
    const client = await mcpClient();
    const rows = async () => {
      const listed = await client.callTool({ name: "conversations__list", arguments: {} });
      const page = listed.structuredContent as {
        conversations: Array<{ id: string; active: boolean }>;
      };
      // The text a model reads says the same as the rows.
      expect(JSON.parse(firstText(listed))).toEqual(page);
      return new Map(page.conversations.map((r) => [r.id, r.active]));
    };
    try {
      for (let i = 0; i < 100 && !(await rows()).has(heldId); i++) await Bun.sleep(20);
      const during = await rows();
      expect(during.get(heldId)).toBe(true);
      expect(during.get(conversationId)).toBe(false);
      releaseHold();
      for (let i = 0; i < 100 && runtime.isTurnActive(SCOPE, heldId); i++) await Bun.sleep(20);
      expect((await rows()).get(heldId)).toBe(false);
    } finally {
      releaseHold();
      await client.close();
    }
  });
});

describe("restart and workspace delete", () => {
  it("history survives a restart of the runtime and the plugin", async () => {
    handle.stop(true);
    await runtime.shutdown();
    runtime = await Runtime.start(config());
    handle = startServer({ runtime, port: 0 });
    const found = await runtime.findConversation(TEST_WORKSPACE_ID, conversationId, {
      userId: DEV_IDENTITY.id,
    });
    expect(found?.title === null || typeof found?.title === "string").toBe(true);
    const store = runtime.workspaceConversationStore(TEST_WORKSPACE_ID, DEV_IDENTITY.id);
    const history = await store.history(found as NonNullable<typeof found>);
    expect(history.filter((m) => m.role === "user")).toHaveLength(2);
  }, 30_000);

  it("purging a deleted workspace deletes its conversations through the plugin", async () => {
    const result = await runWithRequestContext(
      { identity: DEV_IDENTITY, workspaceId: TEST_WORKSPACE_ID },
      () => runtime.deleteWorkspace(TEST_WORKSPACE_ID),
    );
    expect(result.deleted).toBe(true);
    // Deleted, the workspace is restorable: the plugin was not told.
    expect(existsSync(pluginFile(conversationId))).toBe(true);
    expect((await runtime.purgeWorkspace(TEST_WORKSPACE_ID)).purged).toBe(true);
    expect(existsSync(pluginFile(conversationId))).toBe(false);
    expect(existsSync(join(PLUGIN_DATA, "workspaces", TEST_WORKSPACE_ID))).toBe(false);
  });
});
