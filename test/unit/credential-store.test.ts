import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "../../src/tools/credential-store.ts";
import { isRedacted } from "../../src/tools/redacted.ts";

function freshStore(): { store: FileCredentialStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-credstore-"));
  const store = new FileCredentialStore(dir);
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("FileCredentialStore", () => {
  test("get returns null for missing key", async () => {
    const { store, cleanup } = freshStore();
    try {
      expect(await store.get("ws_test", "missing.key")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("put then get round-trips a value, wrapped in Redacted", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.put("ws_test", "hubspot.client_secret", "supersecret");
      const got = await store.get("ws_test", "hubspot.client_secret");
      expect(got).not.toBeNull();
      expect(isRedacted(got)).toBe(true);
      expect(got!.reveal()).toBe("supersecret");
      // Logger paths shouldn't leak the value.
      expect(`${got}`).toBe("[redacted]");
    } finally {
      cleanup();
    }
  });

  test("put writes file with mode 0o600 and parent dir 0o700", async () => {
    const { store, dir, cleanup } = freshStore();
    try {
      await store.put("ws_test", "k1", "v1");
      const filePath = join(dir, "workspaces", "ws_test", "credentials", "secrets", "k1");
      const fileStat = statSync(filePath);
      expect(fileStat.mode & 0o777).toBe(0o600);
      const dirPath = join(dir, "workspaces", "ws_test", "credentials", "secrets");
      const dirStat = statSync(dirPath);
      expect(dirStat.mode & 0o777).toBe(0o700);
    } finally {
      cleanup();
    }
  });

  test("delete removes the file (no error if missing)", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.put("ws_test", "k", "v");
      await store.delete("ws_test", "k");
      expect(await store.get("ws_test", "k")).toBeNull();
      // Idempotent.
      await store.delete("ws_test", "k");
    } finally {
      cleanup();
    }
  });

  test("rejects keys that would escape the directory", async () => {
    const { store, cleanup } = freshStore();
    try {
      await expect(store.put("ws_test", "../evil", "v")).rejects.toThrow();
      await expect(store.put("ws_test", "with/slash", "v")).rejects.toThrow();
      await expect(store.put("ws_test", "..", "v")).rejects.toThrow();
      await expect(store.put("ws_test", ".", "v")).rejects.toThrow();
      await expect(store.put("ws_test", "", "v")).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("rejects invalid wsId", async () => {
    const { store, cleanup } = freshStore();
    try {
      await expect(store.put("../evil", "k", "v")).rejects.toThrow();
      await expect(store.put("not-a-ws", "k", "v")).rejects.toThrow();
      await expect(store.put("", "k", "v")).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("trailing newline on value is trimmed on read", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.put("ws_test", "k", "value\n");
      const got = await store.get("ws_test", "k");
      expect(got!.reveal()).toBe("value");
    } finally {
      cleanup();
    }
  });
});
