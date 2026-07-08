import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityConnectorStore } from "../../../src/identity/connector-store.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";

function freshWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "nb-idc-store-"));
}

/** A URL (remote-oauth) bundle ref — the personal-connector shape. */
function urlRef(serverName: string, url = `https://mcp.example.com/${serverName}`): BundleRef {
  return { url, serverName, ui: null };
}

function recordPath(workDir: string, userId: string): string {
  return join(workDir, "users", userId, "connectors.json");
}

describe("IdentityConnectorStore — construction", () => {
  it("requires a workDir", () => {
    expect(() => new IdentityConnectorStore({ workDir: "" })).toThrow(/workDir is required/);
  });
});

describe("IdentityConnectorStore — list", () => {
  it("returns [] when the user has no record yet (absent file)", async () => {
    const store = new IdentityConnectorStore({ workDir: freshWorkDir() });
    expect(await store.list("usr_alice")).toEqual([]);
  });

  it("does not create the record on a pure read", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    await store.list("usr_alice");
    expect(() => readFileSync(recordPath(workDir, "usr_alice"))).toThrow();
  });

  it("tolerates a record whose connectors field is missing (reads as empty)", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    // Seed a connector, then hand-corrupt the array away.
    await store.add("usr_alice", urlRef("granola"));
    await Bun.write(recordPath(workDir, "usr_alice"), JSON.stringify({ version: 1 }));
    expect(await store.list("usr_alice")).toEqual([]);
  });
});

describe("IdentityConnectorStore — add / persistence", () => {
  it("appends a connector and persists it across a fresh store instance", async () => {
    const workDir = freshWorkDir();
    const ref = urlRef("granola");
    await new IdentityConnectorStore({ workDir }).add("usr_alice", ref);

    // A fresh store (no in-memory state) reads it back from disk.
    const reloaded = await new IdentityConnectorStore({ workDir }).list("usr_alice");
    expect(reloaded).toEqual([ref]);
  });

  it("writes the { version: 1, connectors } shape at users/<id>/connectors.json", async () => {
    const workDir = freshWorkDir();
    const ref = urlRef("granola");
    await new IdentityConnectorStore({ workDir }).add("usr_alice", ref);

    const onDisk = JSON.parse(readFileSync(recordPath(workDir, "usr_alice"), "utf-8"));
    expect(onDisk).toEqual({ version: 1, connectors: [ref] });
  });

  it("keeps two distinct connectors, in install order", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    await store.add("usr_alice", urlRef("granola"));
    const list = await store.add("usr_alice", urlRef("gmail"));
    expect(list.map((r) => (r as { serverName: string }).serverName)).toEqual(["granola", "gmail"]);
  });

  it("upserts by serverName: re-adding the same server replaces in place (no duplicate)", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    await store.add("usr_alice", urlRef("granola", "https://old.example.com/granola"));
    const updated = urlRef("granola", "https://new.example.com/granola");
    const list = await store.add("usr_alice", updated);

    expect(list).toHaveLength(1);
    expect((list[0] as { url: string }).url).toBe("https://new.example.com/granola");
    // And it round-trips.
    expect(await store.get("usr_alice", "granola")).toEqual(updated);
  });

  it("upsert moves the re-added connector to the end", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    await store.add("usr_alice", urlRef("granola"));
    await store.add("usr_alice", urlRef("gmail"));
    const list = await store.add("usr_alice", urlRef("granola"));
    expect(list.map((r) => (r as { serverName: string }).serverName)).toEqual(["gmail", "granola"]);
  });

  it("keys on the derived serverName for a ref with no explicit serverName", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    const ref: BundleRef = { url: "https://mcp.example.com/notion", ui: null };
    await store.add("usr_alice", ref);
    // serverNameFromRef derives the key from the url; get by that same key hits.
    const { serverNameFromRef } = await import("../../../src/bundles/paths.ts");
    expect(await store.get("usr_alice", serverNameFromRef(ref))).toEqual(ref);
  });
});

describe("IdentityConnectorStore — get", () => {
  it("returns the matching connector or null", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    const ref = urlRef("granola");
    await store.add("usr_alice", ref);
    expect(await store.get("usr_alice", "granola")).toEqual(ref);
    expect(await store.get("usr_alice", "gmail")).toBeNull();
    expect(await store.get("usr_bob", "granola")).toBeNull();
  });
});

describe("IdentityConnectorStore — remove", () => {
  it("removes a connector and reports it", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    await store.add("usr_alice", urlRef("granola"));
    await store.add("usr_alice", urlRef("gmail"));

    expect(await store.remove("usr_alice", "granola")).toBe(true);
    expect(await store.list("usr_alice")).toEqual([urlRef("gmail")]);
  });

  it("is idempotent — removing an absent connector is a no-op, not an error", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    await store.add("usr_alice", urlRef("granola"));
    expect(await store.remove("usr_alice", "gmail")).toBe(false);
    expect(await store.remove("usr_bob", "granola")).toBe(false);
    expect(await store.list("usr_alice")).toEqual([urlRef("granola")]);
  });
});

describe("IdentityConnectorStore — per-user isolation", () => {
  it("each user's record is independent — neither sees the other's connectors", async () => {
    const workDir = freshWorkDir();
    const store = new IdentityConnectorStore({ workDir });
    await store.add("usr_alice", urlRef("granola"));
    await store.add("usr_bob", urlRef("gmail"));

    expect(await store.list("usr_alice")).toEqual([urlRef("granola")]);
    expect(await store.list("usr_bob")).toEqual([urlRef("gmail")]);
  });
});

describe("IdentityConnectorStore — path safety", () => {
  it("rejects a traversal-shaped userId (routes through IdentityContext)", async () => {
    const store = new IdentityConnectorStore({ workDir: freshWorkDir() });
    await expect(store.list("../escape")).rejects.toThrow();
    await expect(store.add("with/slash", urlRef("granola"))).rejects.toThrow();
    await expect(store.list("..")).rejects.toThrow();
  });
});
