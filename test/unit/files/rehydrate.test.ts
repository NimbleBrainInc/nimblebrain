import { describe, expect, test } from "bun:test";
import { rehydrateUserResources } from "../../../src/files/rehydrate.ts";
import type { FileStore } from "../../../src/files/store.ts";
import type { StoredMessage } from "../../../src/conversation/types.ts";

/**
 * Minimal FileStore stub. Only `readFile` is exercised by the rehydration
 * path; the other methods throw to make any unintended use loud.
 */
function fakeStore(byId: Record<string, { data: Buffer; mimeType: string; filename: string }>): FileStore {
  return {
    saveFile: () => {
      throw new Error("not used");
    },
    readFile: async (id) => {
      const entry = byId[id];
      if (!entry) throw new Error(`File not found: ${id}`);
      return {
        data: entry.data,
        filename: entry.filename,
        mimeType: entry.mimeType,
        size: entry.data.length,
      };
    },
    resolveFilePath: () => Promise.reject(new Error("not used")),
    appendRegistry: () => Promise.reject(new Error("not used")),
    readRegistry: () => Promise.reject(new Error("not used")),
    findEntry: () => Promise.reject(new Error("not used")),
    appendTombstone: () => Promise.reject(new Error("not used")),
    deleteFile: () => Promise.reject(new Error("not used")),
    ensureFilesDir: () => Promise.reject(new Error("not used")),
  };
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("rehydrateUserResources", () => {
  test("image resource_link → AI SDK file part with raw bytes", async () => {
    const store = fakeStore({
      fl_test1: { data: PNG_BYTES, mimeType: "image/png", filename: "photo.png" },
    });

    const messages: StoredMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what's in this picture?" },
          {
            type: "resource_link",
            uri: "files://fl_test1",
            mimeType: "image/png",
            name: "photo.png",
          },
        ],
        timestamp: "2026-05-07T00:00:00.000Z",
      },
    ];

    const out = await rehydrateUserResources(messages, store);
    expect(out).toHaveLength(1);
    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content).toHaveLength(2);

    expect(msg.content[0]).toEqual({ type: "text", text: "what's in this picture?" });

    const filePart = msg.content[1]!;
    expect(filePart.type).toBe("file");
    if (filePart.type !== "file") return;
    expect(filePart.mediaType).toBe("image/png");
    expect(filePart.filename).toBe("photo.png");
    expect(filePart.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(filePart.data as Uint8Array).equals(PNG_BYTES)).toBe(true);
  });

  test("non-image resource_link → text reference (no model-side file part)", async () => {
    // PDFs and other non-image attachments survive as a text marker — the
    // model can call `files__read` if it needs the bytes, and the AI SDK
    // would drop unknown blocks at the API boundary anyway.
    const store = fakeStore({
      fl_pdf1: { data: Buffer.from("%PDF-1.4"), mimeType: "application/pdf", filename: "doc.pdf" },
    });

    const messages: StoredMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "resource_link",
            uri: "files://fl_pdf1",
            mimeType: "application/pdf",
            name: "doc.pdf",
          },
        ],
        timestamp: "2026-05-07T00:00:00.000Z",
      },
    ];

    const out = await rehydrateUserResources(messages, store);
    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    expect(msg.content[0].text).toContain("doc.pdf");
    expect(msg.content[0].text).toContain("files__read");
  });

  test("missing file → text marker, no throw", async () => {
    const store = fakeStore({});
    const messages: StoredMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "resource_link",
            uri: "files://fl_missing",
            mimeType: "image/png",
            name: "ghost.png",
          },
        ],
        timestamp: "2026-05-07T00:00:00.000Z",
      },
    ];

    const out = await rehydrateUserResources(messages, store);
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

    const out = await rehydrateUserResources(messages, store);
    expect(out).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      },
    ]);
  });

  test("link-vs-store MIME drift: trust the store, fall back to text", async () => {
    // The link claims image/png (passes the early-exit check) but the
    // FileStore reports something non-rehydratable (e.g., a manual JSONL
    // edit or a forward-compat MIME taxonomy migration). The store is
    // the source of truth — fall back to a text marker rather than send
    // a part with a media type that lies about the bytes.
    const store = fakeStore({
      fl_drift: { data: Buffer.from("<svg/>"), mimeType: "image/svg+xml", filename: "ghost.png" },
    });

    const messages: StoredMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "resource_link",
            uri: "files://fl_drift",
            mimeType: "image/png",
            name: "ghost.png",
          },
        ],
        timestamp: "2026-05-07T00:00:00.000Z",
      },
    ];

    const out = await rehydrateUserResources(messages, store);
    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type !== "text") return;
    // Text marker uses the store's MIME — that's what the bytes really are.
    expect(msg.content[0].text).toContain("image/svg+xml");
  });

  test("svg is not rehydrated (Anthropic vision is raster-only)", async () => {
    const store = fakeStore({
      fl_svg: { data: Buffer.from("<svg/>"), mimeType: "image/svg+xml", filename: "logo.svg" },
    });

    const messages: StoredMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "resource_link",
            uri: "files://fl_svg",
            mimeType: "image/svg+xml",
            name: "logo.svg",
          },
        ],
        timestamp: "2026-05-07T00:00:00.000Z",
      },
    ];

    const out = await rehydrateUserResources(messages, store);
    const msg = out[0]!;
    expect(msg.role).toBe("user");
    if (msg.role !== "user") return;
    expect(msg.content[0]?.type).toBe("text");
  });
});
