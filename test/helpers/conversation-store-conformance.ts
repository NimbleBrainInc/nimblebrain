import { describe, expect, test } from "bun:test";
import { collectEvents } from "../../src/conversation/instrument.ts";
import {
  type ConversationChange,
  ConversationCorruptError,
  type ConversationScope,
  type ConversationStore,
} from "../../src/conversation/store.ts";
import type { ConversationEvent } from "../../src/conversation/types.ts";
import { conversationScopeOf } from "../../src/runtime/conversation-scope.ts";

/**
 * What every `ConversationStore` provider must do, whatever medium holds the
 * records (ADR-0075). The suite, not any one provider, is what the interface
 * means: a provider is registered only once it passes.
 *
 * Only what a caller of the interface can observe belongs here. On-disk layout,
 * file names and torn-line recovery are the filesystem provider's own tests.
 */
export interface ConversationStoreHarness {
  store: ConversationStore;
  /** Make a stored conversation unreadable the way this medium can be; absent when it cannot. */
  corrupt?: (scope: ConversationScope, id: string) => Promise<void>;
  cleanup: () => void;
}

export const WS_A = "ws_00000000000000aa";
export const WS_B = "ws_00000000000000bb";

export const scopeOf = (workspaceId: string, ownerId: string): ConversationScope =>
  conversationScopeOf({ workspaceId, identity: { id: ownerId } });

const MODEL = "anthropic:claude-sonnet-5-5";

function userMessage(text: string, ts = new Date().toISOString()): ConversationEvent {
  return { ts, type: "user.message", content: [{ type: "text", text }] };
}

function response(text: string, model = MODEL): ConversationEvent {
  return {
    ts: new Date().toISOString(),
    type: "llm.response",
    runId: "run_1",
    model,
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
    llmMs: 1,
    finishReason: "stop",
  };
}

export function describeConversationStoreConformance(
  label: string,
  makeHarness: () => ConversationStoreHarness,
): void {
  describe(`ConversationStore conformance: ${label}`, () => {
    const withStore = (fn: (h: ConversationStoreHarness) => Promise<void>) => async () => {
      const h = makeHarness();
      try {
        await fn(h);
      } finally {
        h.cleanup();
      }
    };

    const alice = scopeOf(WS_A, "usr_alice");
    const bob = scopeOf(WS_A, "usr_bob");
    const aliceElsewhere = scopeOf(WS_B, "usr_alice");

    test(
      "create then get returns the record in its scope",
      withStore(async ({ store }) => {
        const created = await store.create(alice, { model: MODEL, metadata: { k: "v" } });
        const got = await store.get(alice, created.id);
        expect(got).toMatchObject({
          id: created.id,
          ownerId: "usr_alice",
          workspaceId: WS_A,
          model: MODEL,
          title: null,
          lastModel: null,
          metadata: { k: "v" },
        });
      }),
    );

    test(
      "create with a taken id is refused",
      withStore(async ({ store }) => {
        const id = "conv_0123456789abcdef";
        await store.create(alice, { id, model: MODEL });
        await expect(store.create(alice, { id, model: MODEL })).rejects.toThrow();
      }),
    );

    test(
      "a scope never sees another scope's records, and absent and foreign answer alike",
      withStore(async ({ store }) => {
        const mine = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, mine.id, [userMessage("secret")]);
        for (const other of [bob, aliceElsewhere]) {
          expect(await store.get(other, mine.id)).toBeNull();
          expect(await store.get(other, "conv_ffffffffffffffff")).toBeNull();
          expect(await collectEvents(store, other, mine.id)).toEqual([]);
          expect(await store.update(other, mine.id, { title: "x" })).toBeNull();
          expect(await store.delete(other, mine.id)).toBe(false);
          await expect(store.appendEvents(other, mine.id, [userMessage("x")])).rejects.toThrow();
          expect((await store.list(other, { limit: 10 })).total).toBe(0);
          expect((await store.search(other, { text: "secret", limit: 10 })).total).toBe(0);
        }
        // Nothing the other scopes tried reached the record.
        expect(await store.get(alice, mine.id)).toMatchObject({ title: null });
        expect((await collectEvents(store, alice, mine.id)).length).toBe(1);
      }),
    );

    test(
      "seq is gapless and increasing from 1, and appendEvents returns the last",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        expect(await store.appendEvents(alice, id, [userMessage("a")])).toBe(1);
        expect(await store.appendEvents(alice, id, [response("b"), response("c")])).toBe(3);
        expect(await store.appendEvents(alice, id, [])).toBe(3);
        const seqs = (await collectEvents(store, alice, id)).map((e) => e.seq);
        expect(seqs).toEqual([1, 2, 3]);
      }),
    );

    test(
      "concurrent batches are serialized and never interleave",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        const batches = Array.from({ length: 20 }, (_, b) =>
          Array.from({ length: 5 }, (_, i) => userMessage(`b${b}-${i}`)),
        );
        const lasts = await Promise.all(
          batches.map((batch) => store.appendEvents(alice, id, batch)),
        );
        expect([...lasts].sort((x, y) => x - y)).toEqual(
          Array.from({ length: 20 }, (_, i) => (i + 1) * 5),
        );
        const stored = await collectEvents(store, alice, id);
        expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        // Each batch occupies one contiguous run of seqs, in its own order.
        const texts = stored.map((e) =>
          e.event.type === "user.message" && e.event.content[0]?.type === "text"
            ? e.event.content[0].text
            : "",
        );
        for (let start = 0; start < 100; start += 5) {
          const batch = texts[start]?.split("-")[0];
          expect(texts.slice(start, start + 5)).toEqual(
            Array.from({ length: 5 }, (_, i) => `${batch}-${i}`),
          );
        }
      }),
    );

    test(
      "a batch is all or none: an invalid event writes nothing",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, id, [userMessage("kept")]);
        const withBytes = {
          ...userMessage("x"),
          content: [{ type: "file", data: new Uint8Array([1, 2, 3]) }],
        };
        await expect(
          store.appendEvents(alice, id, [
            userMessage("first"),
            // biome-ignore lint/plugin/double-cast: an event carrying raw bytes, which the type forbids and the store must refuse
            withBytes as unknown as ConversationEvent,
          ]),
        ).rejects.toThrow();
        expect((await collectEvents(store, alice, id)).length).toBe(1);
      }),
    );

    test(
      "events after afterSeq",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, id, [userMessage("1"), userMessage("2"), userMessage("3")]);
        expect((await collectEvents(store, alice, id, { afterSeq: 1 })).map((e) => e.seq)).toEqual([
          2, 3,
        ]);
        expect(await collectEvents(store, alice, id, { afterSeq: 3 })).toEqual([]);
      }),
    );

    test(
      "get projects title, last model and last activity from the events",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        const ts = "2030-01-01T00:00:00.000Z";
        await store.appendEvents(alice, id, [userMessage("hi"), response("yo", "openai:gpt-x")]);
        await store.appendEvents(alice, id, [{ ts, type: "metadata.title", title: "Named" }]);
        expect(await store.get(alice, id)).toMatchObject({
          title: "Named",
          lastModel: "openai:gpt-x",
          updatedAt: ts,
        });
      }),
    );

    test(
      "update sets the title, last writer wins",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        expect(await store.update(alice, id, { title: "one" })).toMatchObject({ title: "one" });
        await store.update(alice, id, { title: "two" });
        expect((await store.get(alice, id))?.title).toBe("two");
        expect(await store.update(alice, "conv_ffffffffffffffff", { title: "x" })).toBeNull();
      }),
    );

    test(
      "delete removes the record and answers false the second time",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        expect(await store.delete(alice, id)).toBe(true);
        expect(await store.get(alice, id)).toBeNull();
        expect(await store.delete(alice, id)).toBe(false);
      }),
    );

    test(
      "deleteWorkspace removes every owner's conversations there and nowhere else, idempotently",
      withStore(async ({ store }) => {
        const a = await store.create(alice, { model: MODEL });
        const b = await store.create(bob, { model: MODEL });
        const kept = await store.create(aliceElsewhere, { model: MODEL });
        await store.deleteWorkspace(WS_A);
        expect(await store.get(alice, a.id)).toBeNull();
        expect(await store.get(bob, b.id)).toBeNull();
        expect(await store.get(aliceElsewhere, kept.id)).not.toBeNull();
        await store.deleteWorkspace(WS_A);
        await store.deleteWorkspace("ws_00000000000000ff");
        // A workspace that was emptied takes new conversations again.
        expect(await store.create(alice, { model: MODEL })).toBeTruthy();
      }),
    );

    test(
      "list summarizes, filters and sorts newest first",
      withStore(async ({ store }) => {
        const old = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, old.id, [
          userMessage("about llamas", "2030-01-01T00:00:00.000Z"),
        ]);
        const recent = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, recent.id, [
          userMessage("about otters", "2030-02-01T00:00:00.000Z"),
          response("ok"),
          {
            ts: "2030-02-01T00:00:01.000Z",
            type: "run.done",
            runId: "run_1",
            stopReason: "complete",
            totalMs: 1,
          },
        ]);
        const page = await store.list(alice, { limit: 10 });
        expect(page.items.map((s) => s.id)).toEqual([recent.id, old.id]);
        expect(page.total).toBe(2);
        expect(page.items[0]).toMatchObject({
          preview: "about otters",
          messageCount: 2,
          lastActivityAt: "2030-02-01T00:00:01.000Z",
          usage: { [MODEL]: { inputTokens: 10, outputTokens: 5 } },
        });
        expect(
          (await store.list(alice, { limit: 10, text: "LLAMA" })).items.map((s) => s.id),
        ).toEqual([old.id]);
        expect(
          (
            await store.list(alice, { limit: 10, updatedFrom: "2030-01-15T00:00:00.000Z" })
          ).items.map((s) => s.id),
        ).toEqual([recent.id]);
      }),
    );

    test(
      "a cursor is stable across inserts between pages",
      withStore(async ({ store }) => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          const { id } = await store.create(alice, { model: MODEL });
          await store.appendEvents(alice, id, [
            userMessage(`m${i}`, `2030-01-0${i + 1}T00:00:00.000Z`),
          ]);
          ids.push(id);
        }
        const first = await store.list(alice, { limit: 2 });
        expect(first.items.map((s) => s.id)).toEqual([ids[4], ids[3]]);
        expect(first.nextCursor).not.toBeNull();
        // Newer than everything listed so far: it belongs before the cursor.
        const inserted = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, inserted.id, [
          userMessage("new", "2031-01-01T00:00:00.000Z"),
        ]);
        const second = await store.list(alice, { limit: 2, cursor: first.nextCursor ?? "" });
        expect(second.items.map((s) => s.id)).toEqual([ids[2], ids[1]]);
        const third = await store.list(alice, { limit: 2, cursor: second.nextCursor ?? "" });
        expect(third.items.map((s) => s.id)).toEqual([ids[0]]);
        expect(third.nextCursor).toBeNull();
      }),
    );

    test(
      "search finds message text with its seq",
      withStore(async ({ store }) => {
        const { id } = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, id, [
          userMessage("nothing here"),
          response("the Pangolin hides"),
        ]);
        await store.create(alice, { model: MODEL });
        const page = await store.search(alice, { text: "pangolin", limit: 10 });
        expect(page.total).toBe(1);
        expect(page.items[0]).toMatchObject({ id, matches: [{ seq: 2 }] });
        expect(page.items[0]?.matches[0]?.snippet).toContain("Pangolin");
        await expect(store.search(alice, { text: "  ", limit: 10 })).rejects.toThrow();
      }),
    );

    test(
      "subscribe publishes one change per operation, with id and scope",
      withStore(async ({ store }) => {
        const seen: ConversationChange[] = [];
        const off = store.subscribe((c) => seen.push(c));
        // One listener that throws does not stop the others.
        const offThrowing = store.subscribe(() => {
          throw new Error("listener failure");
        });
        const { id } = await store.create(alice, { model: MODEL });
        await store.appendEvents(alice, id, [userMessage("a"), userMessage("b")]);
        await store.appendEvents(alice, id, []);
        await store.update(alice, id, { title: "t" });
        await store.delete(alice, id);
        const other = await store.create(bob, { model: MODEL });
        await store.deleteWorkspace(WS_A);
        off();
        offThrowing();
        await store.create(alice, { model: MODEL });
        expect(seen.map((c) => [c.kind, c.id])).toEqual([
          ["created", id],
          ["appended", id],
          ["updated", id],
          ["deleted", id],
          ["created", other.id],
          ["deleted", other.id],
        ]);
        expect(seen[0]?.scope).toMatchObject({ workspaceId: WS_A, ownerId: "usr_alice" });
        expect(seen[5]?.scope).toMatchObject({ workspaceId: WS_A, ownerId: "usr_bob" });
      }),
    );

    test(
      "an unreadable record is the typed error on read, and left out of a listing",
      withStore(async ({ store, corrupt }) => {
        if (!corrupt) return;
        const bad = await store.create(alice, { model: MODEL });
        const good = await store.create(alice, { model: MODEL });
        await corrupt(alice, bad.id);
        await expect(store.get(alice, bad.id)).rejects.toBeInstanceOf(ConversationCorruptError);
        await expect(collectEvents(store, alice, bad.id)).rejects.toBeInstanceOf(
          ConversationCorruptError,
        );
        expect((await store.list(alice, { limit: 10 })).items.map((s) => s.id)).toEqual([good.id]);
      }),
    );

    test(
      "declares whether changes cross processes",
      withStore(async ({ store }) => {
        expect(typeof store.crossProcess).toBe("boolean");
      }),
    );
  });
}
