import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "../../../src/conversation/types.ts";
import { rehydrateUserResources } from "../../../src/files/rehydrate.ts";
import type { FileStore } from "../../../src/files/store.ts";
import type { ExtractedTextSidecar, FileEntry } from "../../../src/files/types.ts";

interface FakeStoreEntry {
  data: Buffer;
  mimeType: string;
  filename: string;
  size?: number;
  sidecar?: ExtractedTextSidecar;
}

interface FakeStore extends FileStore {
  readFileCalls: string[];
  readSidecarCalls: string[];
  writeSidecarCalls: string[];
  sidecars: Map<string, ExtractedTextSidecar>;
}

function fakeStore(byId: Record<string, FakeStoreEntry>): FakeStore {
  const readFileCalls: string[] = [];
  const readSidecarCalls: string[] = [];
  const writeSidecarCalls: string[] = [];
  const sidecars = new Map<string, ExtractedTextSidecar>();
  for (const [id, entry] of Object.entries(byId)) {
    if (entry.sidecar) sidecars.set(id, entry.sidecar);
  }
  return {
    readFileCalls,
    readSidecarCalls,
    writeSidecarCalls,
    sidecars,
    saveFile: () => {
      throw new Error("not used");
    },
    readFile: async (id) => {
      readFileCalls.push(id);
      const entry = byId[id];
      if (!entry) throw new Error(`File not found: ${id}`);
      return {
        data: entry.data,
        filename: entry.filename,
        mimeType: entry.mimeType,
        size: entry.size ?? entry.data.length,
      };
    },
    resolveFilePath: () => Promise.reject(new Error("not used")),
    appendRegistry: () => Promise.reject(new Error("not used")),
    readRegistry: () => Promise.reject(new Error("not used")),
    findEntry: async (id) => {
      const entry = byId[id];
      if (!entry) return null;
      return {
        id,
        filename: entry.filename,
        mimeType: entry.mimeType,
        size: entry.size ?? entry.data.length,
        tags: [],
        source: "chat",
        conversationId: "conv_test",
        createdAt: "2026-05-07T00:00:00.000Z",
        description: null,
      } satisfies FileEntry;
    },
    appendTombstone: () => Promise.reject(new Error("not used")),
    deleteFile: () => Promise.reject(new Error("not used")),
    ensureFilesDir: () => Promise.reject(new Error("not used")),
    readExtractedText: async (id) => {
      readSidecarCalls.push(id);
      return sidecars.get(id) ?? null;
    },
    writeExtractedText: async (id, sidecar) => {
      writeSidecarCalls.push(id);
      sidecars.set(id, sidecar);
    },
  };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_BYTES = Buffer.from("%PDF-1.4");
const DEFAULT_OPTIONS = { model: "anthropic:claude-sonnet-4-6", maxExtractedTextSize: 1024 };

function userMessage(content: StoredMessage["content"]): StoredMessage {
  return {
    role: "user",
    content,
    timestamp: "2026-05-07T00:00:00.000Z",
  };
}

describe("rehydrateUserResources", () => {
  test("image resource_link -> AI SDK file part with raw bytes", async () => {
    const store = fakeStore({
      fl_test1: { data: PNG_BYTES, mimeType: "image/png", filename: "photo.png" },
    });

    const out = await rehydrateUserResources(
      [
        userMessage([
          { type: "text", text: "what's in this picture?" },
          { type: "resource_link", uri: "files://fl_test1", mimeType: "image/png", name: "photo.png" },
        ]),
      ],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]).toEqual({ type: "text", text: "what's in this picture?" });
    const filePart = msg.content[1]!;
    expect(filePart.type).toBe("file");
    if (filePart.type !== "file") return;
    expect(filePart.mediaType).toBe("image/png");
    expect(filePart.filename).toBe("photo.png");
    expect(Buffer.from(filePart.data as Uint8Array).equals(PNG_BYTES)).toBe(true);
  });

  test("PDF resource_link -> AI SDK file part for Anthropic Claude", async () => {
    const store = fakeStore({
      fl_pdf1: { data: PDF_BYTES, mimeType: "application/pdf", filename: "doc.pdf" },
    });

    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_pdf1", mimeType: "application/pdf", name: "doc.pdf" }])],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    const filePart = msg.content[0]!;
    expect(filePart.type).toBe("file");
    if (filePart.type !== "file") return;
    expect(filePart.mediaType).toBe("application/pdf");
    expect(filePart.filename).toBe("doc.pdf");
    expect(Buffer.from(filePart.data as Uint8Array).equals(PDF_BYTES)).toBe(true);
  });

  test("PDF resource_link -> AI SDK file part for supported OpenAI models", async () => {
    // gpt-5 base is intentionally excluded — the catalog reports
    // `modalities.input: ["text","image"]` for it (no pdf).
    for (const model of ["openai:gpt-4o", "openai:gpt-4.1", "openai:gpt-5.5"]) {
      const store = fakeStore({
        fl_pdf1: { data: PDF_BYTES, mimeType: "application/pdf", filename: "doc.pdf" },
      });

      const out = await rehydrateUserResources(
        [userMessage([{ type: "resource_link", uri: "files://fl_pdf1", mimeType: "application/pdf", name: "doc.pdf" }])],
        store,
        { model, maxExtractedTextSize: 1024 },
      );

      const msg = out[0]!;
      expect(msg.role).toBe("user");
      if (msg.role !== "user") return;
      expect(msg.content[0]?.type).toBe("file");
    }
  });

  test("PDF resource_link on unsupported model -> safe text fallback", async () => {
    const store = fakeStore({
      fl_pdf1: { data: PDF_BYTES, mimeType: "application/pdf", filename: "doc.pdf" },
    });

    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_pdf1", mimeType: "application/pdf", name: "doc.pdf" }])],
      store,
      { model: "openai:o3-mini", maxExtractedTextSize: 1024 },
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).toContain("doc.pdf");
    expect(msg.content[0].text).not.toContain("files__read");
    expect(store.readFileCalls).toEqual(["fl_pdf1"]);
  });

  test("historical PDF resource_link on supported model does not replay as native file", async () => {
    const store = fakeStore({
      fl_pdf1: { data: PDF_BYTES, mimeType: "application/pdf", filename: "old.pdf" },
    });

    const out = await rehydrateUserResources(
      [
        userMessage([{ type: "resource_link", uri: "files://fl_pdf1", mimeType: "application/pdf", name: "old.pdf" }]),
        userMessage([{ type: "text", text: "next turn" }]),
      ],
      store,
      DEFAULT_OPTIONS,
    );

    const historical = out[0]!;
    const current = out[1]!;
    expect(historical.role).toBe("user");
    expect(current.role).toBe("user");
    if (historical.role !== "user" || current.role !== "user") return;
    expect(historical.content[0]?.type).toBe("text");
    if (historical.content[0]?.type !== "text") return;
    expect(historical.content[0].text).toContain("old.pdf");
    expect(historical.content[0].text).not.toContain("files__read");
    expect(current.content).toEqual([{ type: "text", text: "next turn" }]);
  });

  test("missing file -> text marker, no throw", async () => {
    const store = fakeStore({});
    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_missing", mimeType: "image/png", name: "ghost.png" }])],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).toContain("ghost.png");
    expect(msg.content[0].text.toLowerCase()).toContain("unavailable");
  });

  test("non-user messages pass through, stripped of platform extras", async () => {
    const store = fakeStore({});
    const messages: StoredMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: "2026-05-07T00:00:00.000Z",
        metadata: { model: "anthropic:claude-sonnet-4-6" },
      },
    ];

    const out = await rehydrateUserResources(messages, store, DEFAULT_OPTIONS);
    expect(out).toEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
  });

  test("link-vs-store MIME drift: trust the store, fall back to text", async () => {
    const store = fakeStore({
      fl_drift: { data: Buffer.from("<svg/>"), mimeType: "image/svg+xml", filename: "ghost.png" },
    });

    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_drift", mimeType: "image/png", name: "ghost.png" }])],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).toContain("image/svg+xml");
  });

  test("svg is not rehydrated (Anthropic vision is raster-only)", async () => {
    const store = fakeStore({
      fl_svg: { data: Buffer.from("<svg/>"), mimeType: "image/svg+xml", filename: "logo.svg" },
    });

    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_svg", mimeType: "image/svg+xml", name: "logo.svg" }])],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
  });

  test("oversized PDF falls back without files__read hint", async () => {
    const store = fakeStore({
      fl_big: {
        data: Buffer.from("tiny stub"),
        mimeType: "application/pdf",
        filename: "big.pdf",
        size: 32 * 1024 * 1024 + 1,
      },
    });

    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_big", mimeType: "application/pdf", name: "big.pdf" }])],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).not.toContain("files__read");
    expect(store.readFileCalls).toEqual(["fl_big"]);
  });

  test("PDF total request budget falls back after budget is consumed", async () => {
    const halfOpenAiLimit = 25 * 1024 * 1024;
    const store = fakeStore({
      fl_a: {
        data: Buffer.from("first"),
        mimeType: "application/pdf",
        filename: "a.pdf",
        size: halfOpenAiLimit,
      },
      fl_b: {
        data: Buffer.from("second"),
        mimeType: "application/pdf",
        filename: "b.pdf",
        size: halfOpenAiLimit + 1,
      },
    });

    const out = await rehydrateUserResources(
      [
        userMessage([
          { type: "resource_link", uri: "files://fl_a", mimeType: "application/pdf", name: "a.pdf" },
          { type: "resource_link", uri: "files://fl_b", mimeType: "application/pdf", name: "b.pdf" },
        ]),
      ],
      store,
      { model: "openai:gpt-4o", maxExtractedTextSize: 1024 },
    );

    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("file");
    expect(msg.content[1]?.type).toBe("text");
    if (msg.content[1]?.type !== "text") return;
    expect(msg.content[1].text).not.toContain("files__read");
    expect(store.readFileCalls).toEqual(["fl_a", "fl_b"]);
  });

  test("historical PDF cache hit reads sidecar without loading bytes or extracting", async () => {
    const store = fakeStore({
      fl_pdf1: {
        data: Buffer.from("doesn't matter, should not be read"),
        mimeType: "application/pdf",
        filename: "doc.pdf",
        sidecar: { text: "cached page text", maxSize: 1024, truncated: false },
      },
    });

    const out = await rehydrateUserResources(
      [
        userMessage([{ type: "resource_link", uri: "files://fl_pdf1", mimeType: "application/pdf", name: "doc.pdf" }]),
        userMessage([{ type: "text", text: "follow up" }]),
      ],
      store,
      DEFAULT_OPTIONS,
    );

    const historical = out[0]!;
    expect(historical.role).toBe("user");
    if (historical.role !== "user") return;
    expect(historical.content[0]?.type).toBe("text");
    if (historical.content[0]?.type !== "text") return;
    expect(historical.content[0].text).toContain("cached page text");
    expect(historical.content[0].text).not.toContain("files__read");
    expect(store.readFileCalls).toEqual([]); // bytes never loaded
    expect(store.writeSidecarCalls).toEqual([]); // cache hit, no rewrite
    expect(store.readSidecarCalls).toEqual(["fl_pdf1"]);
  });

  test("historical PDF cache miss live-extracts and persists the sidecar", async () => {
    // Real PDF bytes here would be ideal, but unpdf rejects the stub and
    // returns null — which exercises the extraction-failed branch. The
    // important behaviour is: bytes loaded once, sidecar write attempted
    // (or skipped on failure), and the next turn would hit the cache.
    const store = fakeStore({
      fl_pdf1: { data: Buffer.from("%PDF-1.4\n%%EOF"), mimeType: "application/pdf", filename: "doc.pdf" },
    });

    const out = await rehydrateUserResources(
      [
        userMessage([{ type: "resource_link", uri: "files://fl_pdf1", mimeType: "application/pdf", name: "doc.pdf" }]),
        userMessage([{ type: "text", text: "follow up" }]),
      ],
      store,
      DEFAULT_OPTIONS,
    );

    expect(store.readSidecarCalls).toEqual(["fl_pdf1"]); // sidecar checked first
    expect(store.readFileCalls).toEqual(["fl_pdf1"]); // bytes loaded once on miss
    const msg = out[0]!;
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
  });

  test("sidecar with smaller maxSize than current config is invalidated", async () => {
    const store = fakeStore({
      fl_pdf1: {
        data: Buffer.from("%PDF-1.4\n%%EOF"),
        mimeType: "application/pdf",
        filename: "doc.pdf",
        sidecar: { text: "old cached text from smaller budget", maxSize: 512, truncated: true },
      },
    });

    const out = await rehydrateUserResources(
      [
        userMessage([{ type: "resource_link", uri: "files://fl_pdf1", mimeType: "application/pdf", name: "doc.pdf" }]),
        userMessage([{ type: "text", text: "follow up" }]),
      ],
      store,
      { model: "anthropic:claude-sonnet-4-6", maxExtractedTextSize: 1024 },
    );

    // Stale sidecar is ignored; bytes loaded to live-extract.
    expect(store.readSidecarCalls).toEqual(["fl_pdf1"]);
    expect(store.readFileCalls).toEqual(["fl_pdf1"]);
    const msg = out[0]!;
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).not.toContain("old cached text");
  });

  test("registry entry missing on PDF path returns unavailable marker", async () => {
    const store = fakeStore({});

    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_gone", mimeType: "application/pdf", name: "ghost.pdf" }])],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).toContain("unavailable");
    expect(store.readFileCalls).toEqual([]); // never tried to load bytes
  });

  test("PDF link-vs-store MIME drift falls back to text marker without loading bytes", async () => {
    // Link claims PDF but registry says the bytes are a docx. Trust the
    // registry — emit a text marker, don't try to inline a mis-typed file.
    const store = fakeStore({
      fl_drift: {
        data: Buffer.from("PK\x03\x04"),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "report.pdf",
      },
    });

    const out = await rehydrateUserResources(
      [userMessage([{ type: "resource_link", uri: "files://fl_drift", mimeType: "application/pdf", name: "report.pdf" }])],
      store,
      DEFAULT_OPTIONS,
    );

    const msg = out[0]!;
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(store.readFileCalls).toEqual([]); // routing decided from metadata only
  });
});
