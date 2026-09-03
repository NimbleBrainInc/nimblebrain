import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "../../src/engine/types.ts";
import {
  type CredentialScope,
  FileCredentialStore,
  credentialScopeLabel,
} from "../../src/tools/credential-store.ts";
import { isRedacted } from "../../src/tools/redacted.ts";

const WS: CredentialScope = { kind: "workspace", wsId: "ws_test" };
const INSTANCE: CredentialScope = { kind: "instance" };
const USER: CredentialScope = { kind: "user", userId: "usr_alex01" };

const READ = { caller: "test", purpose: "unit test" };

function freshStore(): {
  store: FileCredentialStore;
  dir: string;
  events: EngineEvent[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "nb-credstore-"));
  const events: EngineEvent[] = [];
  const store = new FileCredentialStore(dir, { eventSink: { emit: (e) => events.push(e) } });
  return { store, dir, events, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("FileCredentialStore", () => {
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

  test("put writes file with mode 0o600 and parent dir 0o700", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.put(WS, "k1", "v1");
      const filePath = join(dir, "workspaces", "ws_test", "credentials", "secrets", "k1");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      const dirPath = join(dir, "workspaces", "ws_test", "credentials", "secrets");
      expect(statSync(dirPath).mode & 0o777).toBe(0o700);
    } finally {
      cleanup();
    }
  });

  test("delete removes the file (no error if missing)", async () => {
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

  test("trailing newline on value is trimmed on read", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.put(WS, "k", "value\n");
      expect((await store.get(WS, "k", READ))?.reveal()).toBe("value");
    } finally {
      cleanup();
    }
  });
});

describe("scopes", () => {
  // The whole point of the discriminant: same key, three owners, three files.
  // If any pair collided, one tenant's rotation would silently change another's
  // credential — which is the failure a single pooled directory invites.
  test("the same key in three scopes holds three independent values", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.put(INSTANCE, "acme.db_url", "instance-value");
      await store.put(WS, "acme.db_url", "workspace-value");
      await store.put(USER, "acme.db_url", "user-value");

      expect((await store.get(INSTANCE, "acme.db_url", READ))?.reveal()).toBe("instance-value");
      expect((await store.get(WS, "acme.db_url", READ))?.reveal()).toBe("workspace-value");
      expect((await store.get(USER, "acme.db_url", READ))?.reveal()).toBe("user-value");

      // The three roots, asserted as paths so a refactor that collapsed two of
      // them into one directory fails here and not in production.
      expect(statSync(join(dir, "credentials", "secrets", "acme.db_url")).isFile()).toBe(true);
      expect(
        statSync(
          join(dir, "workspaces", "ws_test", "credentials", "secrets", "acme.db_url"),
        ).isFile(),
      ).toBe(true);
      expect(
        statSync(
          join(dir, "users", "usr_alex01", "credentials", "secrets", "acme.db_url"),
        ).isFile(),
      ).toBe(true);
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

  test("credentialScopeLabel names the owner", () => {
    expect(credentialScopeLabel(INSTANCE)).toBe("instance");
    expect(credentialScopeLabel(WS)).toBe("workspace:ws_test");
    expect(credentialScopeLabel(USER)).toBe("user:usr_alex01");
  });
});

describe("list", () => {
  test("returns keys and write times, never values", async () => {
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
});

describe("audit", () => {
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
