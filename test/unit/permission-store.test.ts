import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionStore } from "../../src/permissions/permission-store.ts";

function freshStore(): { store: PermissionStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nb-permstore-"));
  const store = new PermissionStore(dir);
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("PermissionStore", () => {
  test("get returns 'allow' for a tool with no recorded policy", async () => {
    const { store, cleanup } = freshStore();
    try {
      const policy = await store.get(
        { scope: "user", userId: "u1" },
        "gmail",
        "search",
      );
      expect(policy).toBe("allow");
    } finally {
      cleanup();
    }
  });

  test("setConnector + get round-trips a disallow policy", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "disallow" },
      );
      expect(
        await store.get({ scope: "user", userId: "u1" }, "gmail", "send_email"),
      ).toBe("disallow");
      expect(
        await store.get({ scope: "user", userId: "u1" }, "gmail", "search"),
      ).toBe("allow");
    } finally {
      cleanup();
    }
  });

  test("setting a tool to 'allow' deletes it from the store (default state)", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "disallow" },
      );
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "allow" },
      );
      const tools = await store.getConnector(
        { scope: "user", userId: "u1" },
        "gmail",
      );
      expect(tools).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("setConnector merges — tools omitted from input are preserved", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "disallow", trash: "disallow" },
      );
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "allow" },
      );
      const tools = await store.getConnector(
        { scope: "user", userId: "u1" },
        "gmail",
      );
      expect(tools).toEqual({ trash: "disallow" });
    } finally {
      cleanup();
    }
  });

  test("user and workspace scopes are isolated", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "disallow" },
      );
      // Workspace scope at the same name should not see the user's policy.
      expect(
        await store.get(
          { scope: "workspace", wsId: "ws1" },
          "gmail",
          "send_email",
        ),
      ).toBe("allow");
    } finally {
      cleanup();
    }
  });

  test("different users are isolated", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "disallow" },
      );
      expect(
        await store.get({ scope: "user", userId: "u2" }, "gmail", "send_email"),
      ).toBe("allow");
    } finally {
      cleanup();
    }
  });

  test("deleteConnector removes all policies for a connector", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.setConnector(
        { scope: "user", userId: "u1" },
        "gmail",
        { send_email: "disallow", trash: "disallow" },
      );
      await store.deleteConnector({ scope: "user", userId: "u1" }, "gmail");
      const tools = await store.getConnector(
        { scope: "user", userId: "u1" },
        "gmail",
      );
      expect(tools).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("rejects user ids that don't match the safety regex (path-traversal defense)", async () => {
    const { store, cleanup } = freshStore();
    try {
      // Pathological id should resolve to a null path → set throws,
      // get returns the default ("allow") because no record can be loaded.
      const bad = { scope: "user" as const, userId: "../../etc/passwd" };
      expect(await store.get(bad, "gmail", "send_email")).toBe("allow");
      await expect(
        store.setConnector(bad, "gmail", { send_email: "disallow" }),
      ).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});
