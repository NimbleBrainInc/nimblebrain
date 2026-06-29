import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  FileBackedHostResourcesResolver,
  type HostResourceContext,
} from "../../src/host-resources/index.ts";
import { createFileStore, type FileStore } from "../../src/files/store.ts";
import type { FileEntry } from "../../src/files/types.ts";

// The resolver is the single chokepoint between a bundle's inbound
// host-resources request and the workspace-owned FileStore. Files are
// workspace-owned: the resolver is handed a `(wsId) => FileStore` factory and
// DELIBERATELY scopes by `ctx.workspaceId` (the workspace the bundle's tool ran
// in) — passing it to the factory so a `files://` read resolves in that
// workspace's partition only. The URI is bare (carries just the file id); the
// scope rides on the ctx, never the URI. It enforces the scheme allowlist and
// surfaces the MCP-standard error codes (`-32602` for invalid scheme, `-32002`
// for resource not found).

const RESOURCE_NOT_FOUND = -32002;
const INVALID_PARAMS = -32602;

let rootDir: string;

// Two workspace stores standing in for two workspaces. The resolver's factory
// selects between them by the wsId it is handed — the same shape Runtime uses
// (`getWorkspaceFileStore(ctx.workspaceId, owner)` resolves the store for the
// workspace the bundle ran in).
let storeA: FileStore;
let storeB: FileStore;

// ctx carries the bundle's workspace — the LIVE store selector. `ws_a` →
// `storeA`, `ws_b` → `storeB` (see `storeForWorkspace`).
const ctxA: HostResourceContext = { workspaceId: "ws_a", bundleId: "bundle_x" };
const ctxB: HostResourceContext = { workspaceId: "ws_b", bundleId: "bundle_x" };

/**
 * The resolver's store factory: maps `ctx.workspaceId` → that workspace's store,
 * exactly as Runtime does. Honoring the wsId (rather than ignoring it) is the
 * point — a regression where the resolver stopped passing `ctx.workspaceId` to
 * the factory would resolve the wrong workspace, which the isolation test below
 * catches.
 */
function storeForWorkspace(wsId: string): FileStore {
  if (wsId === "ws_a") return storeA;
  if (wsId === "ws_b") return storeB;
  throw new Error(`unexpected workspace id: ${wsId}`);
}

async function seedFile(store: FileStore, name: string, body: string, mime: string) {
  const saved = await store.saveFile(Buffer.from(body), name, mime);
  const entry: FileEntry = {
    id: saved.id,
    filename: name,
    mimeType: mime,
    size: saved.size,
    createdAt: new Date().toISOString(),
    description: undefined,
    tags: [],
  } as unknown as FileEntry;
  await store.appendRegistry(entry);
  return saved.id;
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "nb-host-resources-resolver-"));
  storeA = createFileStore(join(rootDir, "ws_a", "files"));
  storeB = createFileStore(join(rootDir, "ws_b", "files"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function makeResolver(): FileBackedHostResourcesResolver {
  return new FileBackedHostResourcesResolver((wsId) => storeForWorkspace(wsId));
}

describe("FileBackedHostResourcesResolver.read", () => {
  it("returns text contents for a text mime", async () => {
    const id = await seedFile(storeA, "brokers.csv", "company,email\nfoo,foo@x", "text/csv");
    const result = await makeResolver().read(`files://${id}`, ctxA);
    expect(result.contents).toHaveLength(1);
    const entry = result.contents[0];
    expect(entry?.uri).toBe(`files://${id}`);
    expect(entry?.mimeType).toBe("text/csv");
    expect(entry?.text).toBe("company,email\nfoo,foo@x");
    expect(entry?.blob).toBeUndefined();
  });

  it("returns base64 blob contents for a binary mime", async () => {
    const rawBytes = Buffer.from([0x00, 0xff, 0xde, 0xad, 0xbe, 0xef]);
    // Seed directly with raw bytes to avoid UTF-8 reinterpretation.
    const saved = await storeA.saveFile(rawBytes, "data.bin", "application/octet-stream");
    await storeA.appendRegistry({
      id: saved.id,
      filename: "data.bin",
      mimeType: "application/octet-stream",
      size: saved.size,
      createdAt: new Date().toISOString(),
      description: undefined,
      tags: [],
    } as unknown as FileEntry);

    const result = await makeResolver().read(`files://${saved.id}`, ctxA);
    const entry = result.contents[0];
    expect(entry?.text).toBeUndefined();
    expect(typeof entry?.blob).toBe("string");
    // Round-trip the base64 back to bytes and compare byte-for-byte —
    // tolerant of any binary/utf-8 mojibake in the test infrastructure.
    expect(Buffer.from(entry?.blob as string, "base64").equals(rawBytes)).toBe(true);
  });

  it("rejects URIs whose scheme is not in the allowlist", async () => {
    let caught: McpError | null = null;
    try {
      await makeResolver().read("entities://e_abc", ctxA);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect(caught?.code).toBe(INVALID_PARAMS);
    const data = caught?.data as { supported?: string[] } | undefined;
    expect(data?.supported).toContain("files");
  });

  it("returns -32002 for unknown file ids (workspace has the id space, but id not present)", async () => {
    let caught: McpError | null = null;
    try {
      await makeResolver().read("files://fl_doesnotexist", ctxA);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught?.code).toBe(RESOURCE_NOT_FOUND);
  });

  it("collapses cross-workspace lookups into -32002 (no info leak)", async () => {
    // A bundle running in workspace A asking for a file id that EXISTS in
    // workspace B. The resolver passes `ctx.workspaceId` to the factory, yields
    // A's store, which doesn't have it — "not found", the SAME response a
    // genuinely-missing id gets. This prevents cross-workspace inventory
    // enumeration.
    const idInB = await seedFile(storeB, "secret.txt", "ws_b only", "text/plain");
    let caught: McpError | null = null;
    try {
      await makeResolver().read(`files://${idInB}`, ctxA);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught?.code).toBe(RESOURCE_NOT_FOUND);
    // The same lookup from workspace B succeeds, proving the file does exist.
    const ok = await makeResolver().read(`files://${idInB}`, ctxB);
    expect(ok.contents[0]?.text).toBe("ws_b only");
  });

  it("scopes by ctx.workspaceId — a file in workspace A is ABSENT under workspace B", async () => {
    // Seed a file into workspace A. Read it back under ctx A (its own
    // workspace) → found.
    const id = await seedFile(storeA, "a-only.txt", "ws_a only", "text/plain");
    const okA = await makeResolver().read(`files://${id}`, ctxA);
    expect(okA.contents[0]?.text).toBe("ws_a only");

    // The SAME id under ctx workspace B: the resolver passes `ctx.workspaceId`
    // to the store factory, which lands in storeB (no such file) → -32002. If
    // the resolver stopped honoring `ctx.workspaceId` (the regression this
    // guards), B would read A's store and leak the file across workspaces.
    let caught: McpError | null = null;
    try {
      await makeResolver().read(`files://${id}`, ctxB);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught?.code).toBe(RESOURCE_NOT_FOUND);
  });

  it("throws ResponseTooLarge when the file exceeds maxReadSize", async () => {
    const id = await seedFile(storeA, "big.txt", "x".repeat(100), "text/plain");
    const resolver = new FileBackedHostResourcesResolver(
      () => storeA,
      // 10-byte cap, way below the 100-byte fixture
      10,
    );
    let caught: McpError | null = null;
    try {
      await resolver.read(`files://${id}`, ctxA);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught).toBeInstanceOf(McpError);
    // Pin the JSON-RPC code so doc/impl drift fails CI. `-32005` lives in
    // the impl-defined server-error range, alongside `-32004 Rate limited`
    // — both are deliberate quota responses, not server faults.
    expect(caught?.code).toBe(-32005);
    const data = caught?.data as { size?: number; maxSize?: number } | undefined;
    expect(data?.size).toBe(100);
    expect(data?.maxSize).toBe(10);
  });
});

describe("FileBackedHostResourcesResolver.list", () => {
  it("returns the session user's registry entries as resources", async () => {
    await seedFile(storeA, "a1.csv", "x", "text/csv");
    await seedFile(storeA, "a2.csv", "y", "text/csv");
    await seedFile(storeB, "b1.csv", "z", "text/csv");

    const aList = await makeResolver().list({}, ctxA);
    expect(aList.resources).toHaveLength(2);
    expect(aList.resources.map((r) => r.name).sort()).toEqual(["a1.csv", "a2.csv"]);
    // Cross-workspace isolation: workspace A's list never includes B's files.
    expect(aList.resources.find((r) => r.name === "b1.csv")).toBeUndefined();
  });

  it("filters by mimeType when supplied", async () => {
    await seedFile(storeA, "csv1.csv", "x", "text/csv");
    await seedFile(storeA, "doc.md", "y", "text/markdown");

    const result = await makeResolver().list({ filter: { mimeType: "text/csv" } }, ctxA);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]?.name).toBe("csv1.csv");
  });

  it("rejects an unsupported scheme filter with -32602", async () => {
    let caught: McpError | null = null;
    try {
      await makeResolver().list({ filter: { scheme: "entities" } }, ctxA);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught?.code).toBe(INVALID_PARAMS);
  });

  // Tag-shape validation. A buggy bundle sending `tags: "draft"` (string)
  // instead of `tags: ["draft"]` (array) used to throw `TypeError: .every
  // is not a function` and surface as a generic dispatch failure — no
  // useful diagnostic. Now: reject with `-32602`, mirroring the
  // scheme-filter branch. Silently treating non-array as "no filter"
  // was rejected as misleading (the bundle gets all files back instead
  // of a clear error).
  it("rejects non-array tags filter with -32602", async () => {
    let caught: McpError | null = null;
    try {
      // Pass a string where the type cast expects string[]. Coerced
      // through `unknown` because the resolver's TS signature would
      // otherwise reject this at compile time — the runtime guard is
      // what we're exercising.
      await makeResolver().list(
        { filter: { tags: "draft" as unknown as string[] } },
        ctxA,
      );
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught?.code).toBe(INVALID_PARAMS);
  });
});
