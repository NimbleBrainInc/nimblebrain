import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFilesystemConversationStore } from "../../../src/conversation/filesystem-store.ts";
import { collectEvents } from "../../../src/conversation/instrument.ts";
import { createMemoryConversationStore } from "../../../src/conversation/memory-store.ts";
import { workspaceConversationsDir } from "../../../src/conversation/paths.ts";
import {
  describeConversationStoreConformance,
  scopeOf,
  WS_A,
  WS_B,
} from "../../helpers/conversation-store-conformance.ts";
import { makeTestWorkDir } from "../../helpers/test-workdir.ts";

function filesystemHarness() {
  const { workDir, cleanup } = makeTestWorkDir("conv-store");
  for (const ws of [WS_A, WS_B]) mkdirSync(join(workDir, "workspaces", ws), { recursive: true });
  return { workDir, cleanup, store: createFilesystemConversationStore({ workDir }) };
}

describeConversationStoreConformance("filesystem", () => {
  const { workDir, cleanup, store } = filesystemHarness();
  return {
    store,
    cleanup,
    corrupt: async (scope, id) => {
      const file = join(
        workspaceConversationsDir(workDir, scope.workspaceId, scope.ownerId),
        `${id}.jsonl`,
      );
      appendFileSync(file, "{not json\n");
    },
  };
});

describeConversationStoreConformance("memory", () => ({
  store: createMemoryConversationStore(),
  cleanup: () => {},
}));

describe("filesystem provider", () => {
  const alice = scopeOf(WS_A, "usr_alice");
  const MODEL = "anthropic:claude-sonnet-5-5";

  test("declares changes single-process", () => {
    const { store, cleanup } = filesystemHarness();
    expect(store.crossProcess).toBe(false);
    cleanup();
  });

  test("stores today's layout: a header line, then one event per line", async () => {
    const { store, workDir, cleanup } = filesystemHarness();
    try {
      const { id } = await store.create(alice, { model: MODEL });
      await store.appendEvents(alice, id, [
        { ts: "2030-01-01T00:00:00.000Z", type: "metadata.title", title: "t" },
      ]);
      const file = join(workspaceConversationsDir(workDir, WS_A, "usr_alice"), `${id}.jsonl`);
      const lines = readFileSync(file, "utf-8").trimEnd().split("\n");
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id, ownerId: "usr_alice", model: MODEL });
      expect(JSON.parse(lines[0] ?? "")).not.toHaveProperty("workspaceId");
      expect(JSON.parse(lines[1] ?? "")).toMatchObject({ type: "metadata.title", title: "t" });
    } finally {
      cleanup();
    }
  });

  test("a torn last line is not an event, and the next append drops it", async () => {
    const { store, workDir, cleanup } = filesystemHarness();
    try {
      const { id } = await store.create(alice, { model: MODEL });
      await store.appendEvents(alice, id, [
        { ts: "2030-01-01T00:00:00.000Z", type: "metadata.title", title: "a" },
      ]);
      const file = join(workspaceConversationsDir(workDir, WS_A, "usr_alice"), `${id}.jsonl`);
      appendFileSync(file, '{"ts":"2030-01-0');
      expect((await collectEvents(store, alice, id)).length).toBe(1);
      expect(
        await store.appendEvents(alice, id, [
          { ts: "2030-01-02T00:00:00.000Z", type: "metadata.title", title: "b" },
        ]),
      ).toBe(2);
      expect((await store.get(alice, id))?.title).toBe("b");
    } finally {
      cleanup();
    }
  });

  test("a header without an owner is the typed corruption", async () => {
    const { store, workDir, cleanup } = filesystemHarness();
    try {
      const id = "conv_00000000000000aa";
      const dir = workspaceConversationsDir(workDir, WS_A, "usr_alice");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ id, model: MODEL })}\n`);
      await expect(store.get(alice, id)).rejects.toMatchObject({ reason: "missing_owner" });
    } finally {
      cleanup();
    }
  });

  test("a header without a model is the typed corruption", async () => {
    const { store, workDir, cleanup } = filesystemHarness();
    try {
      const id = "conv_00000000000000ab";
      const dir = workspaceConversationsDir(workDir, WS_A, "usr_alice");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ id, ownerId: "usr_alice" })}\n`);
      await expect(store.get(alice, id)).rejects.toMatchObject({ reason: "missing_model" });
    } finally {
      cleanup();
    }
  });

  test("a scope naming a path segment is refused", async () => {
    const { store, cleanup } = filesystemHarness();
    try {
      await expect(
        store.get(scopeOf("..", "usr_alice"), "conv_0000000000000000"),
      ).rejects.toThrow();
      await expect(store.get(scopeOf(WS_A, "a/b"), "conv_0000000000000000")).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("create refuses a workspace whose root is gone", async () => {
    const { store, cleanup } = filesystemHarness();
    try {
      await expect(
        store.create(scopeOf("ws_00000000000000ee", "usr_alice"), { model: MODEL }),
      ).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});
