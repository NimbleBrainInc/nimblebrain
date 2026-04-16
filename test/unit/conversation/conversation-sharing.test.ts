import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlConversationStore } from "../../../src/conversation/jsonl-store.ts";
import { InMemoryConversationStore } from "../../../src/conversation/memory-store.ts";
import type {
  ConversationAccessContext,
  ConversationStore,
} from "../../../src/conversation/types.ts";
import { composeSystemPrompt } from "../../../src/prompt/compose.ts";
import type { ParticipantInfo } from "../../../src/conversation/types.ts";

const testDir = join(tmpdir(), `nimblebrain-sharing-test-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/**
 * Shared test suite that runs against both JSONL and InMemory stores.
 */
function sharingSuite(
  name: string,
  createStore: () => { store: ConversationStore; flush?: () => Promise<void> },
) {
  describe(name, () => {
    let store: ConversationStore;

    beforeEach(() => {
      const created = createStore();
      store = created.store;
    });

    // --- shareConversation ---

    it("shareConversation changes visibility from private to shared", async () => {
      const conv = await store.create({ ownerId: "usr_mat", visibility: "private" });
      expect(conv.visibility).toBe("private");

      const updated = await store.shareConversation(conv.id, "usr_mat");
      expect(updated).not.toBeNull();
      expect(updated!.visibility).toBe("shared");
      expect(updated!.participants).toContain("usr_mat");
    });

    it("shareConversation preserves existing participants", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "private",
        participants: ["usr_mat", "usr_kai"],
      });

      const updated = await store.shareConversation(conv.id, "usr_mat");
      expect(updated!.visibility).toBe("shared");
      expect(updated!.participants).toContain("usr_mat");
      expect(updated!.participants).toContain("usr_kai");
    });

    it("shareConversation returns null for non-owner", async () => {
      const conv = await store.create({ ownerId: "usr_mat", visibility: "private" });

      const result = await store.shareConversation(conv.id, "usr_other");
      expect(result).toBeNull();

      // Verify it remained private
      const loaded = await store.load(conv.id);
      expect(loaded!.visibility).toBe("private");
    });

    it("shareConversation returns null for non-existent conversation", async () => {
      const result = await store.shareConversation("conv_0000000000000000", "usr_mat");
      expect(result).toBeNull();
    });

    it("shareConversation persists to disk (reload check)", async () => {
      const conv = await store.create({ ownerId: "usr_mat", visibility: "private" });
      await store.shareConversation(conv.id, "usr_mat");

      const reloaded = await store.load(conv.id);
      expect(reloaded!.visibility).toBe("shared");
    });

    // --- unshareConversation ---

    it("unshareConversation changes visibility back to private", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat", "usr_kai"],
      });

      const updated = await store.unshareConversation(conv.id, "usr_mat");
      expect(updated).not.toBeNull();
      expect(updated!.visibility).toBe("private");
    });

    it("unshareConversation removes all participants except owner", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat", "usr_kai", "usr_alex"],
      });

      const updated = await store.unshareConversation(conv.id, "usr_mat");
      expect(updated!.participants).toEqual(["usr_mat"]);
    });

    it("unshareConversation returns null for non-owner", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat", "usr_kai"],
      });

      const result = await store.unshareConversation(conv.id, "usr_kai");
      expect(result).toBeNull();
    });

    // --- addParticipant ---

    it("addParticipant adds a user to participants", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat"],
      });

      const updated = await store.addParticipant(conv.id, "usr_kai");
      expect(updated).not.toBeNull();
      expect(updated!.participants).toContain("usr_kai");
      expect(updated!.participants).toContain("usr_mat");
    });

    it("addParticipant makes conversation visible to the new participant", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat"],
      });

      // Before adding, usr_kai cannot see it
      const beforeAccess: ConversationAccessContext = { userId: "usr_kai" };
      const beforeLoad = await store.load(conv.id, beforeAccess);
      expect(beforeLoad).toBeNull();

      await store.addParticipant(conv.id, "usr_kai");

      // After adding, usr_kai can see it
      const afterLoad = await store.load(conv.id, beforeAccess);
      expect(afterLoad).not.toBeNull();
    });

    it("addParticipant is idempotent (no duplicate)", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat"],
      });

      await store.addParticipant(conv.id, "usr_kai");
      const updated = await store.addParticipant(conv.id, "usr_kai");
      const kaiCount = updated!.participants!.filter((p) => p === "usr_kai").length;
      expect(kaiCount).toBe(1);
    });

    it("addParticipant returns null for non-existent conversation", async () => {
      const result = await store.addParticipant("conv_0000000000000000", "usr_kai");
      expect(result).toBeNull();
    });

    // --- removeParticipant ---

    it("removeParticipant removes a user from participants", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat", "usr_kai"],
      });

      const updated = await store.removeParticipant(conv.id, "usr_kai");
      expect(updated).not.toBeNull();
      expect(updated!.participants).not.toContain("usr_kai");
      expect(updated!.participants).toContain("usr_mat");
    });

    it("removeParticipant hides conversation from removed user", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat", "usr_kai"],
      });

      await store.removeParticipant(conv.id, "usr_kai");

      const access: ConversationAccessContext = { userId: "usr_kai" };
      const loaded = await store.load(conv.id, access);
      expect(loaded).toBeNull();
    });

    it("removeParticipant cannot remove the owner", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "shared",
        participants: ["usr_mat", "usr_kai"],
      });

      const result = await store.removeParticipant(conv.id, "usr_mat");
      expect(result).toBeNull();
    });

    it("removeParticipant returns null for non-existent conversation", async () => {
      const result = await store.removeParticipant("conv_0000000000000000", "usr_kai");
      expect(result).toBeNull();
    });

    // --- sharing reveals full history ---

    it("sharing reveals full history to new participants", async () => {
      const conv = await store.create({
        ownerId: "usr_mat",
        visibility: "private",
      });

      // Add some messages
      await store.append(conv, {
        role: "user",
        content: "Hello",
        timestamp: new Date().toISOString(),
        userId: "usr_mat",
      });
      await store.append(conv, {
        role: "assistant",
        content: "Hi there!",
        timestamp: new Date().toISOString(),
      });

      // Share and add participant
      await store.shareConversation(conv.id, "usr_mat");
      await store.addParticipant(conv.id, "usr_kai");

      // New participant can load and see full history
      const access: ConversationAccessContext = { userId: "usr_kai" };
      const loaded = await store.load(conv.id, access);
      expect(loaded).not.toBeNull();

      const history = await store.history(loaded!);
      expect(history).toHaveLength(2);
      expect(history[0].content).toBe("Hello");
    });
  });
}

// --- System prompt participant injection tests ---

describe("System prompt participant section", () => {
  it("includes participant list for shared conversations", () => {
    const participants: ParticipantInfo[] = [
      { userId: "usr_mat", displayName: "Mat" },
      { userId: "usr_kai", displayName: "Kai" },
    ];

    const prompt = composeSystemPrompt(
      [],
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      participants,
    );

    expect(prompt).toContain("## Participants");
    expect(prompt).toContain("This is a shared conversation with the following participants:");
    expect(prompt).toContain("- Mat (usr_mat)");
    expect(prompt).toContain("- Kai (usr_kai)");
  });

  it("does NOT include participant section when no participants provided", () => {
    const prompt = composeSystemPrompt([], null);

    expect(prompt).not.toContain("## Participants");
  });

  it("does NOT include participant section for empty participants array", () => {
    const prompt = composeSystemPrompt(
      [],
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(prompt).not.toContain("## Participants");
  });

  it("uses userId when displayName is not provided", () => {
    const participants: ParticipantInfo[] = [{ userId: "usr_anon" }];

    const prompt = composeSystemPrompt(
      [],
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      participants,
    );

    expect(prompt).toContain("- usr_anon");
    expect(prompt).not.toContain("(usr_anon)");
  });

  it("messages in shared conversation serialize with userId", () => {
    // This tests the StoredMessage type — userId is an optional field
    const message = {
      role: "user" as const,
      content: "Hello from Mat",
      timestamp: new Date().toISOString(),
      userId: "usr_mat",
    };

    const serialized = JSON.stringify(message);
    const parsed = JSON.parse(serialized);
    expect(parsed.userId).toBe("usr_mat");
  });
});

// Run the suite against both store implementations
let jsonlRunCounter = 0;
sharingSuite("Conversation sharing (JSONL)", () => {
  const store = new JsonlConversationStore(
    join(testDir, `jsonl-sharing-${Date.now()}-${++jsonlRunCounter}`),
  );
  return { store, flush: () => store.flush() };
});

sharingSuite("Conversation sharing (InMemory)", () => {
  return { store: new InMemoryConversationStore() };
});
