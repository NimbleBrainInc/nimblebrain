/**
 * A conversation id that is not `conv_` and 16 lowercase hex characters never
 * names a conversation: the store the runtime uses finds none for it, and never
 * resolves it to anything outside the scope's own conversations.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore } from "../helpers/conversation-store.ts";

const dataDir = mkdtempSync(join(tmpdir(), "nb-conv-id-"));
const store = conversationStore(dataDir, "ws_0076759dbbe19fcc", "user_test");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/** What a load of `id` comes to: the conversation, or null whether it answered null or refused. */
async function found(id: string) {
  return store.load(id).catch(() => null);
}

describe("conversation id validation", () => {
  it("loads a conversation by the id create minted", async () => {
    const conv = await store.create({ model: "anthropic:claude-sonnet-4-6", ownerId: "user_test" });
    expect(conv.id).toMatch(/^conv_[a-f0-9]{16}$/);
    expect((await store.load(conv.id))?.id).toBe(conv.id);
  });

  for (const [what, id] of [
    ["a path traversal payload", "../../etc/passwd"],
    ["an id that is too short", "conv_abc123"],
    ["an empty string", ""],
    ["an id with a null byte", "conv_\x00abcdef01234567"],
    ["uppercase hex", "conv_0123456789ABCDEF"],
    ["an id with characters appended", "conv_0123456789abcdef_extra"],
  ] as const) {
    it(`finds nothing for ${what}`, async () => {
      expect(await found(id)).toBeNull();
    });
  }
});
