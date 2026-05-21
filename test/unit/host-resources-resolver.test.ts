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
// host-resources request and the workspace FileStore. It enforces the
// scheme allowlist, looks up the store from the bundle's session
// workspace id (never trusting the URI to encode one), and surfaces the
// MCP-standard error codes (`-32602` for invalid scheme, `-32002` for
// resource not found).

const RESOURCE_NOT_FOUND = -32002;
const INVALID_PARAMS = -32602;

let rootDir: string;

// Seed two workspace stores with different files. The resolver is
// constructed against a factory that picks the right store per wsId —
// the same shape Runtime uses in production.
let wsA: FileStore;
let wsB: FileStore;

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
  wsA = createFileStore(join(rootDir, "ws_a", "files"));
  wsB = createFileStore(join(rootDir, "ws_b", "files"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

function makeResolver(): FileBackedHostResourcesResolver {
  return new FileBackedHostResourcesResolver((wsId) => {
    if (wsId === "ws_a") return wsA;
    if (wsId === "ws_b") return wsB;
    throw new Error(`unknown workspace ${wsId}`);
  });
}

describe("FileBackedHostResourcesResolver.read", () => {
  it("returns text contents for a text mime", async () => {
    const id = await seedFile(wsA, "brokers.csv", "company,email\nfoo,foo@x", "text/csv");
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
    const saved = await wsA.saveFile(rawBytes, "data.bin", "application/octet-stream");
    await wsA.appendRegistry({
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
    // A bundle in ws_a asking for a file id that EXISTS in ws_b. The
    // resolver dispatches to ws_a's store, which doesn't have it. The
    // response is "not found" — the SAME response a genuinely-missing
    // id would get. This prevents cross-tenant inventory enumeration.
    const idInB = await seedFile(wsB, "secret.txt", "ws_b only", "text/plain");
    let caught: McpError | null = null;
    try {
      await makeResolver().read(`files://${idInB}`, ctxA);
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught?.code).toBe(RESOURCE_NOT_FOUND);
    // Same lookup from ws_b succeeds, proving the file does exist.
    const ok = await makeResolver().read(`files://${idInB}`, ctxB);
    expect(ok.contents[0]?.text).toBe("ws_b only");
  });

  it("throws ResponseTooLarge when the file exceeds maxReadSize", async () => {
    const id = await seedFile(wsA, "big.txt", "x".repeat(100), "text/plain");
    const resolver = new FileBackedHostResourcesResolver(
      (wsId) => (wsId === "ws_a" ? wsA : wsB),
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
    const data = caught?.data as { size?: number; maxSize?: number } | undefined;
    expect(data?.size).toBe(100);
    expect(data?.maxSize).toBe(10);
  });
});

describe("FileBackedHostResourcesResolver.list", () => {
  it("returns workspace-scoped registry entries as resources", async () => {
    await seedFile(wsA, "a1.csv", "x", "text/csv");
    await seedFile(wsA, "a2.csv", "y", "text/csv");
    await seedFile(wsB, "b1.csv", "z", "text/csv");

    const aList = await makeResolver().list({}, ctxA);
    expect(aList.resources).toHaveLength(2);
    expect(aList.resources.map((r) => r.name).sort()).toEqual(["a1.csv", "a2.csv"]);
    // Cross-tenant isolation: ws_a's list never includes ws_b's files.
    expect(aList.resources.find((r) => r.name === "b1.csv")).toBeUndefined();
  });

  it("filters by mimeType when supplied", async () => {
    await seedFile(wsA, "csv1.csv", "x", "text/csv");
    await seedFile(wsA, "doc.md", "y", "text/markdown");

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
});
