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
// host-resources request and the caller's identity FileStore. Files are
// identity-owned (Phase B): the resolver is handed a `() => FileStore`
// closure yielding the SESSION USER's store — it never trusts the URI (or
// the ctx workspaceId) to encode a scope. It enforces the scheme allowlist
// and surfaces the MCP-standard error codes (`-32602` for invalid scheme,
// `-32002` for resource not found).

const RESOURCE_NOT_FOUND = -32002;
const INVALID_PARAMS = -32602;

let rootDir: string;

// Two identity stores standing in for two users. `currentStore` is what the
// resolver's closure returns — flipped per test to simulate whose session is
// active, the same shape Runtime uses (resolve the identity per call, hand
// back that user's store).
let storeA: FileStore;
let storeB: FileStore;
let currentStore: FileStore;

// ctx carries the bundle's workspace for AUDIT logging only — it no longer
// selects the store (files are identity-owned).
const ctxA: HostResourceContext = { workspaceId: "ws_a", bundleId: "bundle_x" };
const ctxB: HostResourceContext = { workspaceId: "ws_b", bundleId: "bundle_x" };

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
  storeA = createFileStore(join(rootDir, "usr_a", "files"));
  storeB = createFileStore(join(rootDir, "usr_b", "files"));
  // Default to user A's session; isolation tests flip to B explicitly.
  currentStore = storeA;
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function makeResolver(): FileBackedHostResourcesResolver {
  return new FileBackedHostResourcesResolver(() => currentStore);
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

  it("collapses cross-identity lookups into -32002 (no info leak)", async () => {
    // User A's session asking for a file id that EXISTS in user B's store.
    // The resolver yields A's store, which doesn't have it — "not found",
    // the SAME response a genuinely-missing id gets. This prevents
    // cross-identity inventory enumeration.
    const idInB = await seedFile(storeB, "secret.txt", "usr_b only", "text/plain");
    currentStore = storeA;
    let caught: McpError | null = null;
    try {
      await makeResolver().read(`files://${idInB}`, ctxA);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught?.code).toBe(RESOURCE_NOT_FOUND);
    // Same lookup in user B's session succeeds, proving the file does exist.
    currentStore = storeB;
    const ok = await makeResolver().read(`files://${idInB}`, ctxB);
    expect(ok.contents[0]?.text).toBe("usr_b only");
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

    currentStore = storeA;
    const aList = await makeResolver().list({}, ctxA);
    expect(aList.resources).toHaveLength(2);
    expect(aList.resources.map((r) => r.name).sort()).toEqual(["a1.csv", "a2.csv"]);
    // Cross-identity isolation: user A's list never includes user B's files.
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
