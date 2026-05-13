import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "../../../src/conversation/types.ts";
import { rehydrateUserResources } from "../../../src/files/rehydrate.ts";
import type { FileStore } from "../../../src/files/store.ts";
import type { FileEntry } from "../../../src/files/types.ts";

function fakeStore(
  byId: Record<string, { data: Buffer; mimeType: string; filename: string; size?: number }>,
): FileStore & { readFileCalls: string[] } {
  const readFileCalls: string[] = [];
  return {
    readFileCalls,
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
    for (const model of ["openai:gpt-4o", "openai:gpt-5", "openai:gpt-5.5"]) {
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
      { model: "openai:gpt-5", maxExtractedTextSize: 1024 },
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
});
