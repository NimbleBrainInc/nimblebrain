/**
 * Writes through the store over a bound conversations contract settle with the
 * batch that carried them, and a failed batch closes its conversation's queue
 * until a read shows what was stored (`src/conversation/contract-store.ts`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContractCall,
  type ContractScope,
  createContractConversations,
} from "../../../src/conversation/contract-store.ts";
import type { Conversation, StoredMessage } from "../../../src/conversation/types.ts";
import { inProcessConversations } from "../../helpers/conversation-store.ts";

const SCOPE = { workspaceId: "ws_a", ownerId: "u_1" };
const CONV: Conversation = {
  id: "conv_0123456789abcdef",
  createdAt: "",
  updatedAt: "",
  title: null,
  model: "m",
  lastModel: null,
  ownerId: "u_1",
};

function userMessage(text: string): StoredMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: "2026-01-01T00:00:00Z" };
}

/** A contract whose `append_events` answers from `appendOutcome`, recording every batch. */
function fakeContract(appendOutcome: () => Error | null) {
  const batches: unknown[][] = [];
  const call: ContractCall = async (tool, args) => {
    if (tool === "append_events") {
      batches.push(args.events as unknown[]);
      const err = appendOutcome();
      if (err) throw err;
      return { lastSeq: batches.length };
    }
    if (tool === "events") return { events: [], lastSeq: 0 };
    throw new Error(`unexpected ${tool}`);
  };
  const conversations = createContractConversations(call, { assertWorkspace: () => {} });
  return { batches, store: conversations.forScope(SCOPE) };
}

describe("contract store writes", () => {
  test("every append in a failed batch rejects with the batch's error", async () => {
    const failure = new Error("append failed");
    const { batches, store } = fakeContract(() => failure);
    const results = await Promise.allSettled([
      store.append(CONV, userMessage("one")),
      store.append(CONV, userMessage("two")),
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const r of results) expect((r as PromiseRejectedResult).reason).toBe(failure);
  });

  test("a failed batch refuses later writes until a read, then writes resume", async () => {
    const failure = new Error("append failed");
    let fail = true;
    const { batches, store } = fakeContract(() => (fail ? failure : null));
    await expect(store.append(CONV, userMessage("one"))).rejects.toBe(failure);
    fail = false;
    await expect(store.append(CONV, userMessage("two"))).rejects.toBe(failure);
    expect(batches).toHaveLength(1);

    await store.readEvents(CONV.id);
    await store.append(CONV, userMessage("three"));
    expect(batches).toHaveLength(2);
  });

  test("appends in a batch that lands all resolve", async () => {
    const { batches, store } = fakeContract(() => null);
    const results = await Promise.allSettled([
      store.append(CONV, userMessage("one")),
      store.append(CONV, userMessage("two")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(batches).toHaveLength(1);
  });
});

describe("a conversation id is keyed by its scope", () => {
  // An id is unique only within its scope, so two scopes may each hold one.
  const A: ContractScope = { workspaceId: "ws_aaaaaaaaaaaaaaaa", ownerId: "usr_a" };
  const B: ContractScope = { workspaceId: "ws_bbbbbbbbbbbbbbbb", ownerId: "usr_a" };
  const C: ContractScope = { workspaceId: "ws_aaaaaaaaaaaaaaaa", ownerId: "usr_c" };
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("each scope's batch is sent under its own scope", async () => {
    const sent: Array<{ scope: ContractScope; texts: unknown[] }> = [];
    const call: ContractCall = async (tool, args, scope) => {
      if (tool !== "append_events") throw new Error(`unexpected ${tool}`);
      const events = args.events as Array<{ content: Array<{ text: string }> }>;
      sent.push({ scope, texts: events.map((e) => e.content[0]?.text) });
      return { lastSeq: events.length };
    };
    const conversations = createContractConversations(call, { assertWorkspace: () => {} });
    // Queued together, before either batch drains.
    await Promise.all([
      conversations.forScope(A).append(CONV, userMessage("from a")),
      conversations.forScope(B).append(CONV, userMessage("from b")),
      conversations.forScope(C).append(CONV, userMessage("from c")),
    ]);
    expect(sent).toHaveLength(3);
    expect(sent).toContainEqual({ scope: A, texts: ["from a"] });
    expect(sent).toContainEqual({ scope: B, texts: ["from b"] });
    expect(sent).toContainEqual({ scope: C, texts: ["from c"] });
  });

  test("two scopes appending to one id each land in their own scope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-store-scopes-"));
    dirs.push(dir);
    const conversations = inProcessConversations(dir);
    const scopes = [A, B, C];
    const stores = scopes.map((scope) => conversations.forScope(scope));
    for (const [i, store] of stores.entries()) {
      await store.create({ id: CONV.id, model: "m", ownerId: scopes[i]!.ownerId });
    }

    await Promise.all(stores.map((store, i) => store.append(CONV, userMessage(`message ${i}`))));

    for (const [i, store] of stores.entries()) {
      const texts = (await store.readEvents(CONV.id)).map(
        (e) => (e as { content?: Array<{ text: string }> }).content?.[0]?.text,
      );
      expect(texts).toEqual([`message ${i}`]);
    }
  });
});

describe("a workspace purge", () => {
  test("waits for a create already past the workspace check before it purges", async () => {
    const calls: string[] = [];
    const answer = Promise.withResolvers<void>();
    const call: ContractCall = async (tool) => {
      calls.push(tool);
      if (tool === "create") {
        await answer.promise;
        calls.push("create answered");
        return {
          conversation: { id: CONV.id, createdAt: "", updatedAt: "", model: "m", ownerId: "u_1" },
        };
      }
      if (tool === "delete_workspace") return { deleted: [{ id: CONV.id, ownerId: "u_1" }] };
      throw new Error(`unexpected ${tool}`);
    };
    const conversations = createContractConversations(call, { assertWorkspace: () => {} });
    const created = conversations.forScope(SCOPE).create({ model: "m", ownerId: "u_1" });
    const purged = conversations.deleteWorkspace(SCOPE);
    await Bun.sleep(5);
    expect(calls).toEqual(["create"]);
    answer.resolve();
    await created;
    expect(await purged).toBe(1);
    expect(calls).toEqual(["create", "create answered", "delete_workspace"]);
  });
});
