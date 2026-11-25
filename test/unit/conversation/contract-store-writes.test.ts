/**
 * Writes through the store over a bound conversations contract settle with the
 * batch that carried them, and a failed batch closes its conversation's queue
 * until a read shows what was stored (`src/conversation/contract-store.ts`).
 */

import { describe, expect, test } from "bun:test";
import {
  type ContractCall,
  createContractConversations,
} from "../../../src/conversation/contract-store.ts";
import type { Conversation, StoredMessage } from "../../../src/conversation/types.ts";

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
