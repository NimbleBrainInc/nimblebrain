/**
 * The tool namespace of a bound contract is the kernel's, not the
 * implementation's: a conversations implementation whose `mcp.json` names its
 * server `archive`, bound in place of the default plugin, boots, and agents and the `/mcp/<wsId>` door see
 * `conversations__*`, with the private tools hidden and refused.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-conversations-server-key-${Date.now()}`);
const PLUGIN_DIR = join(testDir, "archive-plugin");
const SERVER_BIN = resolve(import.meta.dir, "../../packages/conversations/bin/nb-conversations");
const PRIVATE_TOOLS = ["create", "events", "append_events", "delete", "delete_workspace"];

/** A conversations implementation whose server key is `archive`, running the built-in server. */
function writeArchivePlugin(): void {
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(
    join(PLUGIN_DIR, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "archive",
      version: "0.1.0",
      extensions: {
        "ai.nimblebrain": {
          implements: [
            { contract: "ai.nimblebrain.conversations", version: "1.0", server: "archive" },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(PLUGIN_DIR, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        archive: {
          type: "stdio",
          command: "bun",
          args: ["--no-env-file", SERVER_BIN, "--data-dir", "${PLUGIN_DATA}"],
        },
      },
    }),
  );
}

let runtime: Runtime;
let handle: ServerHandle;
let conversationId: string;

beforeAll(async () => {
  writeArchivePlugin();
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
    configPath: join(testDir, "nimblebrain.json"),
    // The contract is a singleton: binding another implementation instead of
    // the default turns the default off.
    plugins: { conversations: false, archive: { source: "./archive-plugin", system: true } },
  });
  await provisionTestWorkspace(runtime);
  ({ conversationId } = await runtime.chat({
    identity: DEV_IDENTITY,
    workspaceId: TEST_WORKSPACE_ID,
    message: "hello archive",
  }));
  handle = startServer({ runtime, port: 0 });
}, 60_000);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

describe("a conversations implementation whose server key is archive", () => {
  it("boots and stores the turn in its own data directory", async () => {
    await runtime.workspaceConversationStore(TEST_WORKSPACE_ID, DEV_IDENTITY.id).flush();
    const file = join(
      testDir,
      "plugin-data",
      "archive",
      "workspaces",
      TEST_WORKSPACE_ID,
      "conversations",
      DEV_IDENTITY.id,
      `${conversationId}.jsonl`,
    );
    expect(existsSync(file)).toBe(true);
  });

  it("is served to agents as conversations__*, with no private tool and no archive__*", async () => {
    const names = (await runtime.listToolsForWorkspace(TEST_WORKSPACE_ID, DEV_IDENTITY.id)).map(
      (t) => t.name,
    );
    expect(names).toContain("conversations__list");
    expect(names.some((n) => n.startsWith("archive__"))).toBe(false);
    for (const tool of PRIVATE_TOOLS) expect(names).not.toContain(`conversations__${tool}`);
  });

  it("the door routes conversations__list to it and refuses a private tool", async () => {
    const client = newMcpClient({ name: "server-key-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://localhost:${handle.port}/mcp/${TEST_WORKSPACE_ID}`),
      ),
    );
    try {
      const listed = await client.callTool({ name: "conversations__list", arguments: {} });
      expect(listed.isError).toBeFalsy();
      expect(JSON.stringify(listed.content)).toContain(conversationId);
      const refused = await client
        .callTool({ name: "conversations__events", arguments: { id: conversationId } })
        .then(
          (r) => ({ isError: r.isError === true, text: JSON.stringify(r.content) }),
          (e: Error) => ({ isError: true, text: e.message }),
        );
      expect(refused.isError).toBe(true);
      expect(refused.text).not.toContain("user.message");
    } finally {
      await client.close();
    }
  });
});
