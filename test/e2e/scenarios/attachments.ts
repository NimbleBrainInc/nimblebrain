/**
 * Attachments and the file doors: each kind the composer takes, sent with a chat turn and by the
 * REST upload; the text that reaches the model; the download door's bytes,
 * headers and ranges; and what is refused.
 */

import type { ApiErrorBody, UploadResourceResponse } from "../../../src/api/schemas/responses.ts";
import type { FileRecord } from "../../../src/files/types.ts";
import { structured } from "../client.ts";
import { ATTACHMENTS, type Attachment, EXECUTABLE, MARK } from "../fixtures.ts";
import { expect, expectEq, type Scenario, type ScenarioContext } from "../scenario.ts";

function form(fields: Record<string, string>, files: Attachment[], field = "file"): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const a of files) f.append(field, new Blob([a.bytes], { type: a.mimeType }), a.filename);
  return f;
}

interface ListedFiles {
  files: Array<FileRecord & { id: string }>;
  total: number;
}

export const attachmentsChat: Scenario = {
  id: "attachments.chat",
  title: "Attach txt, csv, docx, xlsx, pdf and png to a turn; what reaches the model",
  requires: ["scripted-model"],
  async run(t) {
    const all = Object.values(ATTACHMENTS);
    const turn = await t.client.turn(t.alice, t.ws, form({ message: "what is attached?" }, all));
    const reply = turn.done?.response ?? "";
    t.note("reply", reply);

    await t.check(
      "a multipart turn stores each file with source chat and its conversation",
      async () => {
        expectEq(turn.startStatus, 200, "start status");
        expectEq(turn.end, "done", "the turn ends");
        const listed = structured<ListedFiles>(
          await t.client.tool(t.alice, t.ws, "files__list", {
            conversationId: turn.conversationId,
          }),
        );
        const names = listed.files.map((f) => f.filename).sort();
        expectEq(names, all.map((a) => a.filename).sort(), "every attachment is stored");
        expect(
          listed.files.every((f) => f.source === "chat"),
          "source chat",
          listed.files.map((f) => f.source),
        );
        return listed.files.map((f) => ({
          filename: f.filename,
          mimeType: f.mimeType,
          source: f.source,
        }));
      },
    );

    await t.check("the text of txt, csv, docx and xlsx reaches the model", () => {
      for (const kind of ["txt", "csv", "docx", "xlsx"] as const) {
        expect(reply.includes(MARK[kind]), `the ${kind} text`, reply.slice(0, 1500));
      }
      return reply
        .split("\n")
        .filter((l) => l.includes("E2E") || l.startsWith("[file"))
        .slice(0, 12);
    });

    await t.check("a PDF reaches a PDF-capable model as a file part or as its text", () => {
      const native = /\[file mediaType=application\/pdf bytes=\d+\]/.test(reply);
      expect(native || reply.includes(MARK.pdf), "a pdf part or its text", reply.slice(0, 1500));
      return { native, text: reply.includes(MARK.pdf) };
    });

    await t.check("an image reaches a vision model as an image file part", () => {
      const m = /\[file mediaType=image\/png bytes=(\d+)\]/.exec(reply);
      expect(m, "an image/png part", reply.slice(0, 1500));
      expectEq(Number(m[1]), ATTACHMENTS.png.bytes.byteLength, "its bytes");
      return m[0];
    });

    await t.check("a turn with files and no message is accepted; neither is 400", async () => {
      const only = await t.client.turn(t.alice, t.ws, form({}, [ATTACHMENTS.txt]));
      expectEq(only.startStatus, 200, "attachment-only start");
      expect(
        only.done?.response.includes(MARK.txt),
        "its text reached the model",
        only.done?.response,
      );
      const empty = await t.client.startChat(t.alice, t.ws, form({}, []));
      expectEq(empty.status, 400, "neither message nor file");
      return { only: only.startStatus, empty: empty.status };
    });
  },
};

export const attachmentsRefused: Scenario = {
  id: "attachments.refused",
  title: "Oversize and disallowed attachments are refused, and limits are advertised",
  async run(t) {
    const boot = await t.client.bootstrap(t.alice);
    const limits = boot.config.files;

    await t.check("bootstrap advertises the attachment limits", () => {
      expect(limits, "config.files is present", boot.config);
      for (const k of ["maxFileSize", "maxTotalSize", "maxFilesPerMessage"] as const) {
        expect(typeof limits[k] === "number", `${k} is a number`, limits);
      }
      return limits;
    });
    if (!limits) return;

    await t.check(
      "a file over maxFileSize is refused naming the limit; too many files are refused",
      async () => {
        const big: Attachment = {
          filename: "big.txt",
          mimeType: "text/plain",
          bytes: new Uint8Array(limits.maxFileSize + 1).fill(0x61),
        };
        const chat = await t.client.startChat(t.alice, t.ws, form({ message: "big" }, [big]));
        expect(chat.status === 400 || chat.status === 413, "chat refuses it", {
          status: chat.status,
          body: chat.json,
        });
        const upload = await t.client.rest(
          t.alice,
          "POST",
          `/v1/workspaces/${t.ws}/resources`,
          form({}, [big]),
        );
        const refused =
          upload.status >= 400 ||
          ((upload.json as UploadResourceResponse | undefined)?.files.length === 0 &&
            ((upload.json as UploadResourceResponse | undefined)?.errors?.length ?? 0) > 0);
        expect(refused, "the upload refuses it", { status: upload.status, body: upload.json });
        const many = Array.from({ length: limits.maxFilesPerMessage + 1 }, (_, i) => ({
          ...ATTACHMENTS.txt,
          filename: `n${i}.txt`,
        }));
        const tooMany = await t.client.startChat(t.alice, t.ws, form({ message: "many" }, many));
        expect(tooMany.status >= 400 && tooMany.status < 500, "too many files refused", {
          status: tooMany.status,
          body: tooMany.json,
        });
        return {
          chat: { status: chat.status, body: chat.json },
          upload: { status: upload.status, body: upload.json },
          tooMany: { status: tooMany.status, body: tooMany.json },
        };
      },
    );

    await t.check("a disallowed type (an .exe) is refused", async () => {
      const chat = await t.client.startChat(t.alice, t.ws, form({ message: "exe" }, [EXECUTABLE]));
      expect(chat.status >= 400 && chat.status < 500, "chat refuses it", chat.status);
      expect(/type|allowed/i.test(chat.text), "the refusal names the type", chat.json);
      return { status: chat.status, body: chat.json };
    });

    await t.check("an octet-stream file with a text extension is stored as text", async () => {
      const typ: Attachment = {
        filename: "notes.typ",
        mimeType: "application/octet-stream",
        bytes: new TextEncoder().encode("= Heading\nTypst body\n"),
      };
      const r = await t.client.rest(
        t.alice,
        "POST",
        `/v1/workspaces/${t.ws}/resources`,
        form({}, [typ]),
      );
      expectEq(r.status, 200, "upload status");
      const file = (r.json as UploadResourceResponse).files[0];
      expectEq(file?.mimeType, "text/plain", "recorded type");
      return file;
    });
  },
};

/** Upload `files` through the REST door, tagged; the answer and the stored txt and png. */
async function upload(t: ScenarioContext, files: Attachment[]) {
  const r = await t.client.rest(
    t.alice,
    "POST",
    `/v1/workspaces/${t.ws}/resources`,
    form({ tags: JSON.stringify(["e2e"]), description: "uploaded by the suite" }, files),
  );
  const body = r.json as UploadResourceResponse;
  const txt = body?.files?.find((f) => f.filename === ATTACHMENTS.txt.filename);
  const png = body?.files?.find((f) => f.filename === ATTACHMENTS.png.filename);
  return { r, body, txt, png };
}

export const filesDownload: Scenario = {
  id: "files.download",
  title: "Upload a file through the REST door and download its bytes",
  groups: ["smoke"],
  async run(t) {
    const { r, body, txt, png } = await upload(t, [ATTACHMENTS.txt, ATTACHMENTS.png]);

    await t.check("an upload stores each file with source app and its tags", () => {
      expectEq(r.status, 200, "upload status");
      expect(txt && png, "both files stored", body);
      expectEq(txt.source, "app", "source");
      expectEq(txt.tags, ["e2e"], "tags");
      return body.files.map((f) => ({ id: f.id, filename: f.filename, source: f.source }));
    });
    if (!txt || !png) return;

    await t.check(
      "download serves the bytes inline under a sandbox CSP, and honours Range",
      async () => {
        const whole = await t.client.rest(t.alice, "GET", `/v1/workspaces/${t.ws}/files/${png.id}`);
        expectEq(whole.status, 200, "status");
        expectEq([...whole.bytes], [...ATTACHMENTS.png.bytes], "the bytes");
        expectEq(whole.headers.get("content-type"), "image/png", "content-type");
        expect(/sandbox/.test(whole.headers.get("content-security-policy") ?? ""), "CSP sandbox", [
          ...whole.headers,
        ]);
        expect(
          /^inline/.test(whole.headers.get("content-disposition") ?? ""),
          "inline disposition",
          [...whole.headers],
        );
        const part = await t.client.rest(
          t.alice,
          "GET",
          `/v1/workspaces/${t.ws}/files/${txt.id}`,
          undefined,
          {
            Range: "bytes=0-4",
          },
        );
        expectEq(part.status, 206, "range status");
        expectEq(part.text, "hello", "the range's bytes");
        expect(/^bytes 0-4\//.test(part.headers.get("content-range") ?? ""), "content-range", [
          ...part.headers,
        ]);
        return {
          headers: Object.fromEntries(
            [
              "content-type",
              "content-security-policy",
              "content-disposition",
              "x-content-type-options",
            ].map((h) => [h, whole.headers.get(h)]),
          ),
          range: part.headers.get("content-range"),
        };
      },
    );
  },
};

export const fileDoors: Scenario = {
  id: "files.doors",
  title: "A refused upload, resource read, served types, the workspace-free door",
  async run(t) {
    const { r, body, txt, png } = await upload(t, [ATTACHMENTS.txt, ATTACHMENTS.png, EXECUTABLE]);

    await t.check("an upload stores the allowed files and lists a refused one in errors", () => {
      expectEq(r.status, 200, "upload status");
      expect(txt && png, "both allowed files stored", body);
      expect((body.errors?.length ?? 0) === 1, "the .exe is listed in errors", body.errors);
      return { files: body.files.map((f) => f.filename), errors: body.errors };
    });
    if (!txt || !png) return;

    await t.check(
      "resources/read of files:// gives text for text and a blob otherwise",
      async () => {
        const a = await t.client.rest(t.alice, "POST", `/v1/workspaces/${t.ws}/resources/read`, {
          server: "files",
          uri: `files://${txt.id}`,
        });
        expectEq(a.status, 200, "text read status");
        const ta = (a.json as { contents: Array<{ text?: string; blob?: string }> }).contents[0];
        expect(ta?.text?.includes(MARK.txt), "text contents", a.json);
        const b = await t.client.rest(t.alice, "POST", `/v1/workspaces/${t.ws}/resources/read`, {
          server: "files",
          uri: `files://${png.id}`,
        });
        const tb = (b.json as { contents: Array<{ text?: string; blob?: string }> }).contents[0];
        expect(typeof tb?.blob === "string", "blob contents", b.json);
        expectEq(
          Buffer.from(tb.blob, "base64").byteLength,
          ATTACHMENTS.png.bytes.byteLength,
          "blob bytes",
        );
        return {
          text: ta.text?.slice(0, 40),
          blobBytes: Buffer.from(tb.blob, "base64").byteLength,
        };
      },
    );

    // Files are served only under a workspace.
    await t.check("the workspace-free GET /v1/files/:id is gone", async () => {
      const old = await t.client.rest(t.alice, "GET", `/v1/files/${txt.id}`);
      expectEq(old.status, 404, "status");
      return { status: old.status, body: old.json ?? old.text.slice(0, 200) };
    });

    // A file is served with the type it was stored with.
    await t.check(
      "a file stored as text/markdown; charset=utf-8 is served with its stored type, nosniff",
      async () => {
        const made = await t.client.tool(t.alice, t.ws, "files__create", {
          manifest: { filename: "p.md", mimeType: "text/markdown; charset=utf-8" },
          body: "# p",
          encoding: "text",
        });
        const id = structured<{ id?: string }>(made).id;
        expect(id, "created", made);
        const got = await t.client.rest(t.alice, "GET", `/v1/workspaces/${t.ws}/files/${id}`);
        expectEq(got.status, 200, "download status");
        expectEq(got.headers.get("content-type"), "text/markdown; charset=utf-8", "served type");
        expectEq(got.headers.get("x-content-type-options"), "nosniff", "nosniff");
        return {
          status: got.status,
          contentType: got.headers.get("content-type"),
          nosniff: got.headers.get("x-content-type-options"),
          stored: structured<{ mimeType?: string }>(
            await t.client.tool(t.alice, t.ws, "files__info", { id }),
          ).mimeType,
        };
      },
    );

    await t.check("an upload naming a malformed conversationId is 400", async () => {
      const bad = await t.client.rest(
        t.alice,
        "POST",
        `/v1/workspaces/${t.ws}/resources`,
        form({ conversationId: "../x" }, [ATTACHMENTS.txt]),
      );
      expectEq(bad.status, 400, "status");
      return (bad.json as ApiErrorBody).error;
    });
  },
};
