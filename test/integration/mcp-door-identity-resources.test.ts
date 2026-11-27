/**
 * The door's unscoped `resources/list` at `/mcp/<wsId>` lists the caller's
 * identity sources' resources (conversations, files, tasks) walled exactly as
 * `resources/read` resolves them: the workspace in the URL, and the caller's
 * own records in it.
 *
 * - Files: the caller's file in workspace A is listed (from the files plugin's
 *   `list`); another owner's file in A and the caller's own file in workspace B
 *   are not.
 * - Conversations: the plugin lists only its screen; the screen is listed, and
 *   no conversation (the caller's in A, another owner's in A, the caller's in
 *   B) appears.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { workDirConversationStore } from "../helpers/conversation-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { seedPluginFile } from "../helpers/files-plugin.ts";
import { newMcpClient } from "../helpers/mcp-client.ts";

const testDir = join(tmpdir(), `nb-door-identity-resources-${Date.now()}`);
const OTHER = "usr_other_owner";

let runtime: Runtime;
let handle: ServerHandle;
let wsA: string;
let wsB: string;
const files: Record<"mine" | "otherOwner" | "otherWorkspace", string> = {
  mine: "",
  otherOwner: "",
  otherWorkspace: "",
};
const conversations: Record<"mine" | "otherOwner" | "otherWorkspace", string> = {
  mine: "",
  otherOwner: "",
  otherWorkspace: "",
};

/** Store a file as `ownerId`'s in `wsId`, as an upload does; returns its id. */
async function seedFile(wsId: string, ownerId: string, filename: string): Promise<string> {
  return (await seedPluginFile(runtime, wsId, ownerId, { filename, body: filename })).id;
}

async function seedConversation(wsId: string, ownerId: string): Promise<string> {
  const conversation = await workDirConversationStore(testDir, wsId, ownerId).create({
    model: "anthropic:claude-sonnet-4-6",
    ownerId,
    workspaceId: wsId,
  });
  return conversation.id;
}

async function listAt(wsId: string): Promise<string[]> {
  const client: Client = newMcpClient({ name: "door-identity-resources", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${handle.port}/mcp/${wsId}`)),
  );
  try {
    return (await client.listResources()).resources.map((r) => r.uri);
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  const store = runtime.getWorkspaceStore();
  // The caller (the dev identity) is a member of both; another owner is in A.
  wsA = (
    await store.create("A", {
      members: [
        { userId: DEV_IDENTITY.id, role: "admin" },
        { userId: OTHER, role: "member" },
      ],
    })
  ).id;
  wsB = (await store.create("B", { members: [{ userId: DEV_IDENTITY.id, role: "admin" }] })).id;

  files.mine = await seedFile(wsA, DEV_IDENTITY.id, "mine.txt");
  files.otherOwner = await seedFile(wsA, OTHER, "theirs.txt");
  files.otherWorkspace = await seedFile(wsB, DEV_IDENTITY.id, "elsewhere.txt");

  conversations.mine = await seedConversation(wsA, DEV_IDENTITY.id);
  conversations.otherOwner = await seedConversation(wsA, OTHER);
  conversations.otherWorkspace = await seedConversation(wsB, DEV_IDENTITY.id);

  handle = startServer({ runtime, port: 0 });
}, 60_000);

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  rmSync(testDir, { recursive: true, force: true });
}, 30_000);

describe("unscoped resources/list at /mcp/<A> lists the caller's identity resources in A only", () => {
  it("lists the caller's own file in A, and neither another owner's nor the caller's in B", async () => {
    const uris = await listAt(wsA);
    expect(uris).toContain(`files://${files.mine}`);
    expect(uris).not.toContain(`files://${files.otherOwner}`);
    expect(uris).not.toContain(`files://${files.otherWorkspace}`);
  });

  it("lists the conversations screen and no conversation of anyone's", async () => {
    const uris = await listAt(wsA);
    expect(uris).toContain("ui://conversations/browser");
    for (const id of Object.values(conversations)) {
      expect(uris.some((uri) => uri.includes(id))).toBe(false);
    }
    expect(uris.filter((uri) => uri.startsWith("ui://conversations/"))).toEqual([
      "ui://conversations/browser",
    ]);
  });

  it("at /mcp/<B> the caller's file in B is listed and the file in A is not", async () => {
    const uris = await listAt(wsB);
    expect(uris).toContain(`files://${files.otherWorkspace}`);
    expect(uris).not.toContain(`files://${files.mine}`);
    expect(uris).not.toContain(`files://${files.otherOwner}`);
  });
});
