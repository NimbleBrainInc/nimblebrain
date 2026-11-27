/**
 * Prompt rehydration over the files contract (`src/files/rehydrate.ts`,
 * CONTRACT.md §10.4): one batched `resolve` per run, a found image or a PDF the
 * model takes streamed from its download URL, a PDF it does not take read as
 * text through `read`, and absent or off as an unavailable marker.
 */

import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "../../../src/conversation/types.ts";
import { rehydrateUserResources } from "../../../src/files/rehydrate.ts";
import { createFakeFilesHost } from "../../helpers/fake-files-host.ts";

const SCOPE = { workspaceId: "ws_0123456789abcdef", ownerId: "usr_a" };
const PDF_MODEL = { model: "anthropic:claude-sonnet-4-6", maxExtractedTextSize: 1024 };
const NO_PDF_MODEL = { model: "openai:o3-mini", maxExtractedTextSize: 1024 };

function user(content: Extract<StoredMessage, { role: "user" }>["content"]): StoredMessage {
  return { role: "user", content, timestamp: "2026-05-07T00:00:00.000Z" };
}

function link(id: string, mimeType: string, name: string) {
  return { type: "resource_link" as const, uri: `files://${id}`, mimeType, name };
}

describe("rehydrateUserResources", () => {
  test("resolves every link of the run in one call, and inlines a found image's bytes", async () => {
    const files = createFakeFilesHost();
    const a = files.seed(SCOPE, { filename: "a.png", mimeType: "image/png", body: "PNGA" });
    const b = files.seed(SCOPE, { filename: "b.jpg", mimeType: "image/jpeg", body: "JPGB" });
    const out = await rehydrateUserResources(
      [
        user([link(a.id, "image/png", "a.png")]),
        { role: "assistant", content: [{ type: "text", text: "ok" }] } as StoredMessage,
        user([{ type: "text", text: "and" }, link(b.id, "image/jpeg", "b.jpg")]),
      ],
      { host: files, scope: SCOPE },
      PDF_MODEL,
    );
    expect(files.calls.filter((c) => c.tool === "resolve")).toHaveLength(1);
    const first = out[0];
    if (first?.role !== "user") throw new Error("expected a user message");
    expect(first.content[0]).toMatchObject({
      type: "file",
      mediaType: "image/png",
      filename: "a.png",
    });
    const data = (first.content[0] as { data: { data: Uint8Array } }).data.data;
    expect(new TextDecoder().decode(data)).toBe("PNGA");
  });

  test("a PDF in the current message is inlined for a model that takes PDFs", async () => {
    const files = createFakeFilesHost();
    const d = files.seed(SCOPE, { filename: "d.pdf", mimeType: "application/pdf", body: "%PDF" });
    const out = await rehydrateUserResources(
      [user([link(d.id, "application/pdf", "d.pdf")])],
      { host: files, scope: SCOPE },
      PDF_MODEL,
    );
    expect(out[0]?.content[0]).toMatchObject({ type: "file", mediaType: "application/pdf" });
  });

  test("a PDF the model cannot take gets its text from read, bounded", async () => {
    const files = createFakeFilesHost();
    const d = files.seed(SCOPE, { filename: "d.pdf", mimeType: "application/pdf", body: "%PDF" });
    files.texts.set(d.id, "page one text");
    const out = await rehydrateUserResources(
      [user([link(d.id, "application/pdf", "d.pdf")])],
      { host: files, scope: SCOPE },
      NO_PDF_MODEL,
    );
    const part = out[0]?.content[0] as { type: string; text: string };
    expect(part.type).toBe("text");
    expect(part.text).toContain("page one text");
    expect(part.text).toContain("`pages`");
    expect(files.calls.find((c) => c.tool === "read")).toMatchObject({
      args: { id: d.id, maxBytes: 1024 },
    });
  });

  test("a file another owner holds, or one deleted, is unavailable", async () => {
    const files = createFakeFilesHost();
    const theirs = files.seed(
      { ...SCOPE, ownerId: "usr_b" },
      { filename: "t.png", mimeType: "image/png", body: "x" },
    );
    const out = await rehydrateUserResources(
      [user([link(theirs.id, "image/png", "t.png"), link("fl_gone", "image/png", "g.png")])],
      { host: files, scope: SCOPE },
      PDF_MODEL,
    );
    expect(out[0]?.content).toEqual([
      { type: "text", text: "[Attachment unavailable: t.png]" },
      { type: "text", text: "[Attachment unavailable: g.png]" },
    ]);
  });

  test("with files off, every link is unavailable and nothing is asked", async () => {
    const out = await rehydrateUserResources(
      [user([link("fl_a", "image/png", "a.png")])],
      null,
      PDF_MODEL,
    );
    expect(out[0]?.content).toEqual([{ type: "text", text: "[Attachment unavailable: a.png]" }]);
  });

  test("an SVG or another type is a reference to read, and is not resolved", async () => {
    const files = createFakeFilesHost();
    const out = await rehydrateUserResources(
      [user([link("fl_s", "image/svg+xml", "s.svg")])],
      { host: files, scope: SCOPE },
      PDF_MODEL,
    );
    const part = out[0]?.content[0] as { text: string } | undefined;
    expect(part?.text).toContain("call files__read");
    expect(files.calls).toEqual([]);
  });
});
