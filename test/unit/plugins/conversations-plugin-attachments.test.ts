/**
 * A user message's attachments read back as the person sent them: `get` answers the
 * person's own text with the attachments as `files`, and the host's `attached` text (an
 * attachment's extracted text, which the model reads) is never shown, in `get`, the `list`
 * preview or `search`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool } from "../../../packages/conversations/src/server.ts";
import { type ConversationStore, createStore } from "../../../packages/conversations/src/store.ts";

const SCOPE = { workspaceId: "ws_a77a77a77a77a77a", ownerId: "usr_attach" };
const host = { principal: "host" as const, ...SCOPE };
const person = { principal: "person" as const, ...SCOPE };
const FILE = {
  id: "fl_0123456789abcdef",
  filename: "notes.txt",
  mimeType: "text/plain",
  size: 16,
  extracted: true,
};

let dir: string;
let store: ConversationStore;
let id: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "conversations-attach-"));
  store = createStore(dir);
  const created = await callTool(store, "create", { model: "anthropic:m" }, host);
  id = (created.structuredContent as { conversation: { id: string } }).conversation.id;
  await callTool(
    store,
    "append_events",
    {
      id,
      events: [
        {
          ts: "2026-01-01T00:00:00.000Z",
          type: "user.message",
          content: [
            { type: "text", text: "what do these say?" },
            {
              type: "text",
              text: "--- Attached: notes.txt (fl_0123456789abcdef, 16 B) ---\nalpha beta gamma",
              attached: true,
            },
          ],
          files: [FILE],
        },
      ],
    },
    host,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a user message with an attachment", () => {
  test("get answers the person's text and the attachment as files", async () => {
    const got = await callTool(store, "get", { id, expand: "full" }, person);
    const { messages } = got.structuredContent as {
      messages: Array<{ content: string; blocks: unknown[]; files?: unknown[] }>;
    };
    expect(messages[0]?.content).toBe("what do these say?");
    expect(messages[0]?.blocks).toEqual([{ type: "text", text: "what do these say?" }]);
    expect(messages[0]?.files).toEqual([FILE]);
  });

  test("the list preview is the person's text", async () => {
    const listed = await callTool(store, "list", {}, person);
    const rows = (listed.structuredContent as { conversations: Array<{ preview: string }> })
      .conversations;
    expect(rows[0]?.preview).toBe("what do these say?");
  });

  test("search does not match the attachment's text", async () => {
    const out = await callTool(store, "search", { query: "alpha beta" }, person);
    expect((out.structuredContent as { results: unknown[] }).results).toEqual([]);
  });
});
