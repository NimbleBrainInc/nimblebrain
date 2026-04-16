import { describe, expect, it, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import { EventSourcedConversationStore } from "../../src/conversation/event-sourced-store.ts";
import type { ConversationStore } from "../../src/conversation/types.ts";

function storeTests(name: string, makeStore: () => ConversationStore) {
  describe(name, () => {
    let store: ConversationStore;

    beforeEach(() => {
      store = makeStore();
    });

    it("accepts a valid conversation id format", async () => {
      // create() generates a valid ID internally — load should not throw on format
      const conv = await store.create();
      const loaded = await store.load(conv.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(conv.id);
    });

    it("rejects path traversal payload (../../etc/passwd)", async () => {
      await expect(store.load("../../etc/passwd")).rejects.toThrow(
        /Invalid conversation ID/,
      );
    });

    it("rejects id that is too short (conv_abc123)", async () => {
      await expect(store.load("conv_abc123")).rejects.toThrow(
        /Invalid conversation ID/,
      );
    });

    it("rejects empty string", async () => {
      await expect(store.load("")).rejects.toThrow(/Invalid conversation ID/);
    });

    it("rejects string with null bytes", async () => {
      await expect(
        store.load("conv_\x00abcdef01234567"),
      ).rejects.toThrow(/Invalid conversation ID/);
    });

    it("rejects uppercase hex characters", async () => {
      await expect(store.load("conv_0123456789ABCDEF")).rejects.toThrow(
        /Invalid conversation ID/,
      );
    });

    it("rejects id with extra characters appended", async () => {
      await expect(
        store.load("conv_0123456789abcdef_extra"),
      ).rejects.toThrow(/Invalid conversation ID/);
    });
  });
}

let counter = 0;
function tempDir(prefix: string): string {
  const dir = join(tmpdir(), `nb-test-conv-id-${prefix}-${Date.now()}-${++counter}`);
  return dir;
}

const jsonlDir = tempDir("jsonl");
const esDir = tempDir("es");

storeTests(
  "JsonlConversationStore conversation id validation",
  () => new JsonlConversationStore(join(jsonlDir, `run-${++counter}`)),
);

storeTests(
  "EventSourcedConversationStore conversation id validation",
  () =>
    new EventSourcedConversationStore({
      dir: join(esDir, `run-${++counter}`),
    }),
);
