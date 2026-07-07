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
          { scope: "workspace", wsId: "ws_one" },
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

describe("PermissionStore — personal-connector grants", () => {
  const WS = "ws_helix";
  const WS2 = "ws_acme";

  test("isConnectorGranted is false (deny) with no grant recorded", async () => {
    const { store, cleanup } = freshStore();
    try {
      expect(await store.isConnectorGranted("u1", "granola", WS)).toBe(false);
      expect(await store.getConnectorGrants("u1", "granola")).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("grant + isConnectorGranted round-trips, scoped to the granted workspace", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.grantConnector("u1", "granola", WS);
      expect(await store.isConnectorGranted("u1", "granola", WS)).toBe(true);
      // Not granted to a different workspace.
      expect(await store.isConnectorGranted("u1", "granola", WS2)).toBe(false);
      expect(await store.getConnectorGrants("u1", "granola")).toEqual([WS]);
    } finally {
      cleanup();
    }
  });

  test("grantConnector is idempotent — no duplicate workspace ids", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.grantConnector("u1", "granola", WS);
      await store.grantConnector("u1", "granola", WS);
      expect(await store.getConnectorGrants("u1", "granola")).toEqual([WS]);
    } finally {
      cleanup();
    }
  });

  test("revokeConnector removes one workspace and prunes empty keys", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.grantConnector("u1", "granola", WS);
      await store.grantConnector("u1", "granola", WS2);
      await store.revokeConnector("u1", "granola", WS);
      expect(await store.getConnectorGrants("u1", "granola")).toEqual([WS2]);
      // Last grant removed → connector key pruned, listing is empty.
      await store.revokeConnector("u1", "granola", WS2);
      expect(await store.getConnectorGrants("u1", "granola")).toEqual([]);
      expect(await store.listConnectorGrants("u1")).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("revokeConnector on a non-existent grant is a no-op", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.revokeConnector("u1", "granola", WS); // never granted
      expect(await store.listConnectorGrants("u1")).toEqual({});
    } finally {
      cleanup();
    }
  });

  test("grants are isolated per user", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.grantConnector("u1", "granola", WS);
      expect(await store.isConnectorGranted("u2", "granola", WS)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("grants and tool policies coexist in the same record", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.setConnector({ scope: "user", userId: "u1" }, "granola", {
        delete_note: "disallow",
      });
      await store.grantConnector("u1", "granola", WS);
      // Both survive round-trips through the shared file.
      expect(
        await store.get({ scope: "user", userId: "u1" }, "granola", "delete_note"),
      ).toBe("disallow");
      expect(await store.isConnectorGranted("u1", "granola", WS)).toBe(true);
      // And a tool-policy edit doesn't clobber the grant.
      await store.setConnector({ scope: "user", userId: "u1" }, "granola", {
        delete_note: "allow",
      });
      expect(await store.isConnectorGranted("u1", "granola", WS)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("write is strict — malformed connector name or workspace id throws", async () => {
    const { store, cleanup } = freshStore();
    try {
      await expect(store.grantConnector("u1", "bad name!", WS)).rejects.toThrow();
      await expect(
        store.grantConnector("u1", "granola", "../../etc"),
      ).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  test("read fails closed — malformed workspace id is not granted", async () => {
    const { store, cleanup } = freshStore();
    try {
      await store.grantConnector("u1", "granola", WS);
      expect(await store.isConnectorGranted("u1", "granola", "not-a-ws")).toBe(false);
    } finally {
      cleanup();
    }
  });
});
