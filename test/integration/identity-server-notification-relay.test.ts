/**
 * A person's own apps announce their writes, and the host relays each
 * announcement to that person's event stream alone.
 *
 * `conversations`, `files` and `automations` belong to a person, not a
 * workspace: one in-process server each, shared by every user and composed into
 * no workspace registry. This drives the whole path — a real write through the
 * door a user's app or agent uses, the source's server sending
 * `notifications/resources/list_changed`, the identity relay, and the
 * `server.notification` frame on a real `/v1/events` stream — and checks that a
 * member of the same workspace, on their own stream, hears nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serverNotificationsRelayedTotal } from "../../src/api/metrics.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const LIST_CHANGED = "notifications/resources/list_changed";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-identity-notification-relay-${Date.now()}`);

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** Read SSE frames off a stream into a list, until released. */
function readFrames(stream: ReadableStream<Uint8Array>): { frames: Frame[]; release: () => void } {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffered = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let end = buffered.indexOf("\n\n");
        while (end !== -1) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const event = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
          end = buffered.indexOf("\n\n");
        }
      }
    } catch {
      // Released or aborted.
    }
  })();
  return { frames, release: () => void reader.cancel().catch(() => {}) };
}

/** The owner's own `/v1/events` stream — the one their browser tabs hold. */
async function openOwnStream(): Promise<{ frames: Frame[]; release: () => void }> {
  // The response head goes out with the stream's first chunk, so the fetch
  // resolves only once something is broadcast.
  const kick = setTimeout(
    () => handle.sseManager.broadcast("heartbeat", { timestamp: new Date().toISOString() }),
    50,
  );
  const res = await fetch(`${baseUrl}/v1/events`);
  clearTimeout(kick);
  expect(res.status).toBe(200);
  if (!res.body) throw new Error("no event stream body");
  return readFrames(res.body);
}

async function createMcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { "x-workspace-id": TEST_WORKSPACE_ID } },
  });
  const client = new Client({ name: "app-iframe", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function notificationsFor(frames: Frame[], server: string): Record<string, unknown>[] {
  return frames.filter((f) => f.event === "server.notification" && f.data.server === server).map((f) => f.data);
}

/** Poll until `predicate` holds or the deadline passes. */
async function eventually(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function forwardedCount(): Promise<number> {
  const metric = await serverNotificationsRelayedTotal.get();
  return metric.values.find((v) => v.labels.outcome === "forwarded")?.value ?? 0;
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("a person's own apps announce their writes to that person", () => {
  it("files: a file created through /mcp reaches its owner's stream, naming no workspace, and no other member's", async () => {
    const own = await openOwnStream();
    // Another member of the very workspace the file was written in.
    const colleague = readFrames(
      handle.sseManager.addIdentityClient("usr_colleague", new Set([TEST_WORKSPACE_ID])),
    );
    const client = await createMcpClient();
    try {
      const forwardedBefore = await forwardedCount();
      const result = await client.callTool({
        name: "files__create",
        arguments: {
          manifest: { filename: "notes.md", mimeType: "text/markdown" },
          body: "# notes",
          encoding: "text",
        },
      });
      expect(result.isError).toBeFalsy();

      await eventually(() => notificationsFor(own.frames, "files").length > 0);
      expect(notificationsFor(own.frames, "files")).toEqual([
        { server: "files", userId: DEV_IDENTITY.id, method: LIST_CHANGED },
      ]);
      expect((await forwardedCount()) - forwardedBefore).toBeGreaterThanOrEqual(1);
      expect(notificationsFor(colleague.frames, "files")).toEqual([]);
    } finally {
      await client.close();
      own.release();
      colleague.release();
    }
  });

  it("files: a file deleted through /mcp reaches its owner's stream", async () => {
    const client = await createMcpClient();
    try {
      const created = await client.callTool({
        name: "files__create",
        arguments: {
          manifest: { filename: "scratch.txt", mimeType: "text/plain" },
          body: "scratch",
          encoding: "text",
        },
      });
      const [block] = created.content as Array<{ type: string; text: string }>;
      const { id } = JSON.parse(block?.text ?? "{}") as { id: string };
      // Let the create's coalescing window close, so what arrives next is the delete's.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const own = await openOwnStream();
      try {
        const deleted = await client.callTool({ name: "files__delete", arguments: { id } });
        expect(deleted.isError).toBeFalsy();

        await eventually(() => notificationsFor(own.frames, "files").length > 0);
        expect(notificationsFor(own.frames, "files")[0]).toEqual({
          server: "files",
          userId: DEV_IDENTITY.id,
          method: LIST_CHANGED,
        });
      } finally {
        own.release();
      }
    } finally {
      await client.close();
    }
  });

  it("automations: an automation created through /mcp reaches its owner's stream", async () => {
    const own = await openOwnStream();
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: "automations__create",
        arguments: {
          manifest: {
            name: "weekly-digest",
            schedule: { type: "interval", intervalMs: 7 * 24 * 60 * 60 * 1000 },
          },
          body: "Summarize the week.",
        },
      });
      expect(result.isError).toBeFalsy();

      await eventually(() => notificationsFor(own.frames, "automations").length > 0);
      expect(notificationsFor(own.frames, "automations")[0]).toEqual({
        server: "automations",
        userId: DEV_IDENTITY.id,
        method: LIST_CHANGED,
      });
    } finally {
      await client.close();
      own.release();
    }
  });

  it("conversations: a conversation created in the conversation store reaches its owner's stream", async () => {
    const own = await openOwnStream();
    try {
      await runtime
        .workspaceConversationStore(TEST_WORKSPACE_ID, DEV_IDENTITY.id)
        .create({ ownerId: DEV_IDENTITY.id, workspaceId: TEST_WORKSPACE_ID });

      await eventually(() => notificationsFor(own.frames, "conversations").length > 0);
      expect(notificationsFor(own.frames, "conversations")[0]).toEqual({
        server: "conversations",
        userId: DEV_IDENTITY.id,
        method: LIST_CHANGED,
      });
    } finally {
      own.release();
    }
  });

  it("conversations: a conversation started by chat reaches its owner's stream", async () => {
    // A chat turn is the door a person uses most, and the list view hears a
    // new conversation only through this announcement.
    const own = await openOwnStream();
    try {
      await runtime.chat({ message: "Hello", workspaceId: TEST_WORKSPACE_ID });

      await eventually(() => notificationsFor(own.frames, "conversations").length > 0);
      expect(notificationsFor(own.frames, "conversations")[0]).toEqual({
        server: "conversations",
        userId: DEV_IDENTITY.id,
        method: LIST_CHANGED,
      });
    } finally {
      own.release();
    }
  });
});
