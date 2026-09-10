import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "../../src/engine/types.ts";
import type { CredentialScope, CredentialStore } from "../../src/tools/credential-store.ts";
import { isRedacted } from "../../src/tools/redacted.ts";

/**
 * The properties every `CredentialStore` has, whatever holds the bytes.
 *
 * `CredentialStore` promises "an opaque secret store rather than a file store"
 * (ADR-0027), and that promise is only worth something if a second backend can
 * be held to the same behaviour. A suite written against the concrete class
 * cannot do that: it asserts file modes and paths alongside the round-trip, so
 * running it against another backend means deciding, per assertion, which half
 * of it was the interface. That decision is made once, here.
 *
 * What belongs in this block: anything a caller of the interface can observe —
 * the round-trip, the three scopes being three owners, key and id validation,
 * `list` semantics, and the audit contract. What does NOT: file modes, on-disk
 * paths, temp-file naming. Those are true of `FileCredentialStore` and stay in
 * its own block.
 */
export interface CredentialStoreHarness {
  store: CredentialStore;
  /** Everything the store's event sink emitted, in order. */
  events: EngineEvent[];
  cleanup: () => void;
}

export const WS: CredentialScope = { kind: "workspace", wsId: "ws_test" };
export const INSTANCE: CredentialScope = { kind: "instance" };
export const USER: CredentialScope = { kind: "user", userId: "usr_alex01" };

export const READ = { caller: "test", purpose: "unit test" };

/**
 * Run the interface suite against one backend. `label` names it in the test
 * output, so a failure says which backend broke rather than which line did.
 */
export function describeCredentialStoreConformance(
  label: string,
  freshStore: () => CredentialStoreHarness,
): void {
  describe(`${label} — CredentialStore conformance`, () => {
    test("get returns null for missing key", async () => {
      const { store, cleanup } = freshStore();
      try {
        expect(await store.get(WS, "missing.key", READ)).toBeNull();
      } finally {
        cleanup();
      }
    });

    test("put then get round-trips a value, wrapped in Redacted", async () => {
      const { store, cleanup } = freshStore();
      try {
        await store.put(WS, "acme.db_url", "supersecret");
        const got = await store.get(WS, "acme.db_url", READ);
        expect(got).not.toBeNull();
        expect(isRedacted(got)).toBe(true);
        expect(got?.reveal()).toBe("supersecret");
        // Logger paths shouldn't leak the value.
        expect(`${got}`).toBe("[redacted]");
      } finally {
        cleanup();
      }
    });

    test("delete removes the secret (no error if missing)", async () => {
      const { store, cleanup } = freshStore();
      try {
        await store.put(WS, "k", "v");
        await store.delete(WS, "k");
        expect(await store.get(WS, "k", READ)).toBeNull();
        // Idempotent.
        await store.delete(WS, "k");
      } finally {
        cleanup();
      }
    });

    test("rejects keys that would escape the directory", async () => {
      const { store, cleanup } = freshStore();
      try {
        await expect(store.put(WS, "../evil", "v")).rejects.toThrow();
        await expect(store.put(WS, "with/slash", "v")).rejects.toThrow();
        await expect(store.put(WS, "..", "v")).rejects.toThrow();
        await expect(store.put(WS, ".", "v")).rejects.toThrow();
        await expect(store.put(WS, "", "v")).rejects.toThrow();
      } finally {
        cleanup();
      }
    });

    test("rejects invalid wsId", async () => {
      const { store, cleanup } = freshStore();
      try {
        await expect(store.put({ kind: "workspace", wsId: "../evil" }, "k", "v")).rejects.toThrow();
        await expect(store.put({ kind: "workspace", wsId: "not-a-ws" }, "k", "v")).rejects.toThrow();
        await expect(store.put({ kind: "workspace", wsId: "" }, "k", "v")).rejects.toThrow();
      } finally {
        cleanup();
      }
    });

    test("rejects a userId that would escape the users tree", async () => {
      const { store, cleanup } = freshStore();
      try {
        await expect(store.put({ kind: "user", userId: ".." }, "k", "v")).rejects.toThrow();
        await expect(store.put({ kind: "user", userId: "a/b" }, "k", "v")).rejects.toThrow();
        await expect(store.put({ kind: "user", userId: "" }, "k", "v")).rejects.toThrow();
      } finally {
        cleanup();
      }
    });

    // The whole point of the discriminant: same key, three owners, three values.
    // If any pair collided, one tenant's rotation would silently change
    // another's credential — which is the failure a single pooled namespace
    // invites. `FileCredentialStore`'s own block pins the three roots as paths;
    // this is the part that is true of any backend.
    test("the same key in three scopes holds three independent values", async () => {
      const { store, cleanup } = freshStore();
      try {
        await store.put(INSTANCE, "acme.db_url", "instance-value");
        await store.put(WS, "acme.db_url", "workspace-value");
        await store.put(USER, "acme.db_url", "user-value");

        expect((await store.get(INSTANCE, "acme.db_url", READ))?.reveal()).toBe("instance-value");
        expect((await store.get(WS, "acme.db_url", READ))?.reveal()).toBe("workspace-value");
        expect((await store.get(USER, "acme.db_url", READ))?.reveal()).toBe("user-value");
      } finally {
        cleanup();
      }
    });

    test("deleting in one scope leaves the others alone", async () => {
      const { store, cleanup } = freshStore();
      try {
        await store.put(INSTANCE, "k", "i");
        await store.put(WS, "k", "w");
        await store.delete(WS, "k");
        expect(await store.get(WS, "k", READ)).toBeNull();
        expect((await store.get(INSTANCE, "k", READ))?.reveal()).toBe("i");
      } finally {
        cleanup();
      }
    });

    test("list returns keys and write times, never values", async () => {
      const { store, cleanup } = freshStore();
      try {
        await store.put(WS, "b.key", "second");
        await store.put(WS, "a.key", "first");
        const keys = await store.list(WS);
        expect(keys.map((k) => k.key)).toEqual(["a.key", "b.key"]);
        for (const entry of keys) {
          expect(Number.isNaN(Date.parse(entry.updatedAt))).toBe(false);
          expect(JSON.stringify(entry)).not.toContain("first");
          expect(JSON.stringify(entry)).not.toContain("second");
        }
      } finally {
        cleanup();
      }
    });

    test("an unwritten scope lists empty rather than throwing", async () => {
      const { store, cleanup } = freshStore();
      try {
        expect(await store.list(WS)).toEqual([]);
        expect(await store.list(INSTANCE)).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("a reveal emits one event carrying scope, key, caller and purpose", async () => {
      const { store, events, cleanup } = freshStore();
      try {
        await store.put(WS, "acme.db_url", "supersecret");
        const got = await store.get(WS, "acme.db_url", {
          caller: "transport:header",
          purpose: "outbound MCP request header Authorization",
        });
        expect(events).toHaveLength(0); // the read alone is not a use
        got?.reveal();
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
          type: "audit.credential_read",
          data: {
            scope: "workspace:ws_test",
            key: "acme.db_url",
            caller: "transport:header",
            purpose: "outbound MCP request header Authorization",
            workspaceId: "ws_test",
          },
        });
      } finally {
        cleanup();
      }
    });

    test("the event never carries the value", async () => {
      const { store, events, cleanup } = freshStore();
      try {
        await store.put(WS, "k", "supersecret");
        (await store.get(WS, "k", READ))?.reveal();
        expect(JSON.stringify(events)).not.toContain("supersecret");
      } finally {
        cleanup();
      }
    });

    test("a probe that never reveals emits nothing", async () => {
      const { store, events, cleanup } = freshStore();
      try {
        await store.put(WS, "k", "v");
        await store.get(WS, "k", READ);
        await store.get(WS, "absent", READ);
        expect(events).toEqual([]);
      } finally {
        cleanup();
      }
    });

    test("repeated reveals of one read emit once", async () => {
      const { store, events, cleanup } = freshStore();
      try {
        await store.put(WS, "k", "v");
        const got = await store.get(WS, "k", READ);
        got?.reveal();
        got?.reveal();
        got?.reveal();
        expect(events).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    test("each read is its own audit subject", async () => {
      const { store, events, cleanup } = freshStore();
      try {
        await store.put(WS, "k", "v");
        (await store.get(WS, "k", { caller: "a", purpose: "first" }))?.reveal();
        (await store.get(WS, "k", { caller: "b", purpose: "second" }))?.reveal();
        expect(events.map((e) => e.data.caller)).toEqual(["a", "b"]);
      } finally {
        cleanup();
      }
    });

    test("a user-scope read stamps the userId; an instance read stamps neither", async () => {
      const { store, events, cleanup } = freshStore();
      try {
        await store.put(USER, "k", "v");
        await store.put(INSTANCE, "k", "v");
        (await store.get(USER, "k", READ))?.reveal();
        (await store.get(INSTANCE, "k", READ))?.reveal();
        expect(events[0]?.data).toMatchObject({ scope: "user:usr_alex01", userId: "usr_alex01" });
        expect(events[1]?.data).toEqual({
          scope: "instance",
          key: "k",
          caller: "test",
          purpose: "unit test",
        });
      } finally {
        cleanup();
      }
    });
  });
}
