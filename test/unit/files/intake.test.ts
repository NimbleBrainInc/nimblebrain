/**
 * The one intake (`src/files/intake.ts`, CONTRACT.md §10.2–3) over an
 * in-memory files host: checks before any upload opens, begin → stream →
 * complete, a chat turn all or none with rollback, and the model's view of the
 * files it took in.
 */

import { describe, expect, test } from "bun:test";
import {
  attachmentParts,
  fileRefusal,
  type IntakeBody,
  IntakeError,
  requestRefusals,
  takeInFile,
  takeInTurn,
} from "../../../src/files/intake.ts";
import { ContractToolError } from "../../../src/plugins/bound-servers.ts";
import { createFakeFilesHost } from "../../helpers/fake-files-host.ts";

const SCOPE = {
  workspaceId: "ws_0123456789abcdef",
  ownerId: "usr_a",
  conversationId: "conv_0123456789abcdef",
};

function body(filename: string, content: string, mimeType = "text/plain"): IntakeBody {
  const bytes = new TextEncoder().encode(content);
  return { filename, mimeType, size: bytes.byteLength, open: () => new Blob([bytes]).stream() };
}

describe("checks before any upload opens", () => {
  const limits = { maxFiles: 2, maxFileSize: 10, maxTotalSize: 15 };

  test("count and total refuse the request as a whole", () => {
    expect(requestRefusals([body("a", "1"), body("b", "2"), body("c", "3")], limits)[0]).toContain(
      "Too many files",
    );
    expect(requestRefusals([body("a", "123456789"), body("b", "123456789")], limits)[0]).toContain(
      "Total file size",
    );
    expect(requestRefusals([body("a", "1")], limits)).toEqual([]);
  });

  test("size and the allowlist refuse one file by name; no type is octet-stream", () => {
    expect(fileRefusal(body("big.txt", "12345678901"), 10)).toContain('"big.txt"');
    expect(fileRefusal(body("a.js", "x", "text/javascript"), 10)).toContain("disallowed type");
    expect(fileRefusal(body("a.typ", "x", ""), 10)).toBeNull();
    expect(fileRefusal(body("a.md", "x", "Text/Markdown; charset=utf-8"), 10)).toBeNull();
  });
});

describe("takeInFile", () => {
  test("begins as the uploader with the turn in the context, streams, completes", async () => {
    const files = createFakeFilesHost();
    const record = await takeInFile(files, SCOPE, body("a.typ", "hello", ""), {
      source: "app",
      tags: ["t"],
    });
    expect(record.filename).toBe("a.typ");
    expect(files.calls.map((c) => c.tool)).toEqual(["begin_upload", "complete_upload"]);
    expect(files.calls[0]).toMatchObject({
      scope: SCOPE,
      args: {
        filename: "a.typ",
        mimeType: "application/octet-stream",
        size: 5,
        source: "app",
        tags: ["t"],
      },
    });
  });

  test("a failure is an IntakeError naming the file, never a URL", async () => {
    const files = createFakeFilesHost();
    files.transfer.upload = async () => {
      throw new Error("http://127.0.0.1:1/t/secret.token refused");
    };
    const err = await takeInFile(files, SCOPE, body("a.txt", "x"), { source: "app" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntakeError);
    expect((err as Error).message).toContain('"a.txt"');
    expect((err as Error).message).not.toContain("secret");
  });

  test("the plugin not reached is unavailable, which a door answers as retryable", async () => {
    const files = createFakeFilesHost();
    files.beginUpload = async () => {
      throw Object.assign(new Error("Connection closed"), { code: "CONNECTION_CLOSED" });
    };
    const err = await takeInFile(files, SCOPE, body("a.txt", "x"), { source: "app" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IntakeError);
    expect((err as IntakeError).unavailable).toBe(true);
  });

  test("the plugin's refusal is not unavailable", async () => {
    const files = createFakeFilesHost();
    files.beginUpload = async () => {
      throw new ContractToolError("too_large", "too large");
    };
    const err = await takeInFile(files, SCOPE, body("a.txt", "x"), { source: "app" }).catch(
      (e: unknown) => e,
    );
    expect((err as IntakeError).unavailable).toBe(false);
    expect((err as IntakeError).message).toContain("larger than the files plugin accepts");
  });
});

describe("takeInTurn", () => {
  test("opens every upload, then streams every body, then completes every one", async () => {
    const files = createFakeFilesHost();
    const records = await takeInTurn(files, SCOPE, [body("a.txt", "a"), body("b.txt", "b")]);
    expect(records.map((r) => r.filename)).toEqual(["a.txt", "b.txt"]);
    expect(files.calls.map((c) => c.tool)).toEqual([
      "begin_upload",
      "begin_upload",
      "complete_upload",
      "complete_upload",
    ]);
  });

  test("a failed PUT completes nothing", async () => {
    const files = createFakeFilesHost();
    const put = files.transfer.upload;
    let n = 0;
    files.transfer.upload = async (url, upload) => {
      if (++n === 2) throw new Error("refused");
      return put(url, upload);
    };
    await expect(
      takeInTurn(files, SCOPE, [body("a.txt", "a"), body("b.txt", "b")]),
    ).rejects.toThrow(IntakeError);
    expect(files.calls.some((c) => c.tool === "complete_upload")).toBe(false);
  });

  test("a failed complete deletes, as host walled to the uploader, every file already completed", async () => {
    const files = createFakeFilesHost();
    const complete = files.completeUpload;
    let n = 0;
    files.completeUpload = async (scope, id) => {
      if (++n === 2) throw new ContractToolError("upload_incomplete", "x");
      return complete(scope, id);
    };
    await expect(
      takeInTurn(files, SCOPE, [body("a.txt", "a"), body("b.txt", "b")]),
    ).rejects.toThrow(IntakeError);
    const deletes = files.calls.filter((c) => c.tool === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.scope).toMatchObject({ workspaceId: SCOPE.workspaceId, ownerId: "usr_a" });
    expect((await files.list(SCOPE, {})).files).toEqual([]);
  });
});

describe("attachmentParts", () => {
  test("text comes from read with the host's bound; images and PDFs travel as resource links", async () => {
    const files = createFakeFilesHost();
    const note = files.seed(SCOPE, { filename: "n.md", mimeType: "text/markdown", body: "# hi" });
    const pic = files.seed(SCOPE, { filename: "p.png", mimeType: "image/png", body: "x" });
    const pdf = files.seed(SCOPE, { filename: "d.pdf", mimeType: "application/pdf", body: "x" });
    const zip = files.seed(SCOPE, { filename: "z.zip", mimeType: "application/zip", body: "x" });
    files.texts.set(note.id, "# hi there, long text");
    const { contentParts, fileRefs } = await attachmentParts(
      files,
      SCOPE,
      [note, pic, pdf, zip],
      8,
    );
    expect(files.calls.find((c) => c.tool === "read")).toMatchObject({
      args: { id: note.id, maxBytes: 8 },
    });
    expect(contentParts[0]).toMatchObject({ type: "text" });
    expect((contentParts[0] as { text: string }).text).toContain("# hi the");
    expect((contentParts[0] as { text: string }).text).toContain("truncated");
    expect(contentParts[1]).toEqual({
      type: "resource_link",
      uri: `files://${pic.id}`,
      mimeType: "image/png",
      name: "p.png",
    });
    expect(contentParts[2]).toMatchObject({ type: "resource_link", uri: `files://${pdf.id}` });
    expect((contentParts[3] as { text: string }).text).toContain("binary file");
    expect(fileRefs.map((r) => r.extracted)).toEqual([true, false, false, false]);
  });
});
