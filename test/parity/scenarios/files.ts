/**
 * The files tools as an agent or the Files screen calls them, a download link
 * in a chat tool result, and the owner wall inside one workspace.
 */

import { structured, textOf } from "../client.ts";
import { directive } from "../directive-model.ts";
import { ATTACHMENTS, MARK } from "../fixtures.ts";
import { expect, expectEq, type Scenario } from "../scenario.ts";

interface Listed {
  files: Array<{ id: string; filename: string; tags?: string[]; folderId?: string | null }>;
  total: number;
  nextCursor?: string | null;
  folders?: Array<{ id: string; name: string }>;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const filesTools: Scenario = {
  id: "files.tools",
  title: "files__create, info, read, list, search, tag, move, delete and folders",
  covers: [
    "FI-1",
    "FI-2",
    "FI-3",
    "FI-4",
    "FI-5",
    "FI-6",
    "FI-7",
    "FI-8",
    "FI-9",
    "FI-10",
    "FI-11",
    "FI-12",
    "FI-13",
    "FI-14",
    "FI-15",
    "MCP-91",
  ],
  async run(t) {
    const call = (name: string, args: Record<string, unknown>) =>
      t.client.tool(t.alice, t.ws, `files__${name}`, args);
    const tag = `parity-${Date.now().toString(36)}`;

    const made = await call("create", {
      manifest: {
        filename: "report.md",
        mimeType: "text/markdown",
        folder: "Parity/Reports",
        tags: [tag],
      },
      body: `# Report\n${MARK.txt}\n`,
      encoding: "text",
    });
    const report = structured<{ id: string; filename: string; folderId: string | null }>(made);
    const pdf = structured<{ id: string }>(
      await call("create", {
        manifest: { filename: "paper.pdf", mimeType: "application/pdf", tags: [tag] },
        body: b64(ATTACHMENTS.pdf.bytes),
      }),
    );
    const png = structured<{ id: string }>(
      await call("create", {
        manifest: { filename: "dot.png", mimeType: "image/png", tags: [tag] },
        body: b64(ATTACHMENTS.png.bytes),
      }),
    );

    await t.check(
      ["FI-6", "MCP-91"],
      "create writes the file with source agent, making its folder path",
      async () => {
        expect(!made.isError && report.id, "created", textOf(made));
        expect(report.folderId, "placed in a folder", report);
        const info = structured<{ source: string; folderId: string | null }>(
          await call("info", { id: report.id }),
        );
        expectEq(info.source, "agent", "source");
        return { report, source: info.source };
      },
    );

    await t.check("FI-8", "info gives the record", async () => {
      const info = structured<{
        id: string;
        filename: string;
        mimeType: string;
        size: number;
        tags: string[];
      }>(await call("info", { id: report.id }));
      expectEq(
        [info.id, info.filename, info.mimeType],
        [report.id, "report.md", "text/markdown"],
        "the record",
      );
      expect(info.tags.includes(tag), "its tags", info);
      return info;
    });

    await t.check("FI-3", "read gives the text and a resource link", async () => {
      const r = await call("read", { id: report.id });
      const out = structured<{ extractedText: string | null }>(r);
      expect(out.extractedText?.includes(MARK.txt), "the text", out);
      const link = (r.content as Array<{ type: string; uri?: string }>).find(
        (c) => c.type === "resource_link",
      );
      expectEq(link?.uri, `files://${report.id}`, "a resource link to the file");
      return { text: out.extractedText, link };
    });

    await t.check("FI-4", "read of an image gives metadata and a link, no bytes", async () => {
      const r = await call("read", { id: png.id });
      const out = structured<{ extractedText: string | null; mimeType: string }>(r);
      expect(!out.extractedText, "no text", out);
      expect(!JSON.stringify(r).includes(b64(ATTACHMENTS.png.bytes)), "no bytes", r);
      return out;
    });

    // Decided on next/engine (inventory FI-5): read_pdf_pages is read {id, pages}.
    await t.check(
      "FI-5",
      "read {id, pages} gives a PDF's pages; read_pdf_pages is gone",
      async () => {
        const r = await call("read", { id: pdf.id, pages: [1, 2] });
        const out = structured<{
          pages?: Array<{ page: number; text: string }>;
          totalPages?: number;
          missingPages?: number[];
        }>(r);
        expect(JSON.stringify(out).includes(MARK.pdf), "page 1's text", out);
        expectEq(out.totalPages, 1, "totalPages");
        expect(JSON.stringify(out.missingPages ?? []).includes("2"), "page 2 is missing", out);
        const old = await call("read_pdf_pages", { id: pdf.id, pages: [1] });
        expect(old.isError, "read_pdf_pages refused", textOf(old));
        return { out, old: textOf(old).slice(0, 160) };
      },
    );

    // Decided on next/engine (inventory FI-1): cursor paging.
    await t.check("FI-1", "list filters by tag and pages by cursor", async () => {
      const first = structured<Listed>(await call("list", { tags: [tag], limit: 2 }));
      expectEq(first.total, 3, "total across pages");
      expectEq(first.files.length, 2, "page size");
      expect(typeof first.nextCursor === "string", "a next cursor", first);
      const second = structured<Listed>(
        await call("list", { tags: [tag], limit: 2, cursor: first.nextCursor }),
      );
      const ids = [...first.files, ...second.files].map((f) => f.id).sort();
      expectEq(ids, [report.id, pdf.id, png.id].sort(), "every file once");
      return { total: first.total, pages: [first.files.length, second.files.length] };
    });

    await t.check("FI-2", "search matches filename and tags", async () => {
      const byName = structured<Listed>(await call("search", { query: "report" }));
      expect(
        byName.files.some((f) => f.id === report.id),
        "by filename",
        byName,
      );
      const byTag = structured<Listed>(await call("search", { query: tag }));
      expectEq(byTag.files.length, 3, "by tag");
      return { byName: byName.total, byTag: byTag.total };
    });

    await t.check("FI-9", "tag adds and removes", async () => {
      const r = structured<{ tags: string[] }>(
        await call("tag", { id: png.id, add: ["kept"], remove: [tag] }),
      );
      expectEq(r.tags.sort(), ["kept"], "tags after");
      return r;
    });

    const folder = structured<{ id: string; name: string }>(
      await call("create_folder", { manifest: { name: "Parity Archive" } }),
    );

    await t.check("FI-12", "create_folder makes one; a taken name is a conflict", async () => {
      expect(folder.id, "made", folder);
      const again = await call("create_folder", { manifest: { name: "Parity Archive" } });
      expect(again.isError, "the same name refused", textOf(again));
      return { folder, again: textOf(again).slice(0, 200) };
    });

    await t.check("FI-11", "move moves every file or none", async () => {
      const r = structured<{ ids: string[]; folderId: string | null }>(
        await call("move", { ids: [pdf.id, png.id], folderId: folder.id }),
      );
      expectEq(r.folderId, folder.id, "destination");
      const bad = await call("move", { ids: [report.id, "file_missing0000"], folderId: "root" });
      expect(bad.isError, "a missing id refuses the move", textOf(bad));
      const info = structured<{ folderId: string | null }>(await call("info", { id: report.id }));
      expect(info.folderId !== null, "nothing moved", info);
      return { moved: r, refused: textOf(bad).slice(0, 160) };
    });

    await t.check(
      "FI-13",
      "update_folder renames; moving a folder into itself is refused",
      async () => {
        const renamed = await call("update_folder", {
          id: folder.id,
          manifest: { name: "Parity Archive 2" },
        });
        expect(!renamed.isError, "renamed", textOf(renamed));
        const loop = await call("update_folder", {
          id: folder.id,
          manifest: { parentId: folder.id },
        });
        expect(loop.isError, "into itself refused", textOf(loop));
        return { renamed: structured(renamed), loop: textOf(loop).slice(0, 160) };
      },
    );

    await t.check(
      "FI-14",
      "delete_folder refuses a non-empty folder and deletes an empty one",
      async () => {
        const full = await call("delete_folder", { id: folder.id });
        expect(full.isError, "non-empty refused", textOf(full));
        const empty = structured<{ id: string }>(
          await call("create_folder", { manifest: { name: "Parity Empty" } }),
        );
        const gone = await call("delete_folder", { id: empty.id });
        expect(!gone.isError, "empty deleted", textOf(gone));
        return { full: textOf(full).slice(0, 160), gone: structured(gone) };
      },
    );

    await t.check(
      "FI-10",
      "delete removes the file from list, read and the download door",
      async () => {
        const del = await call("delete", { id: png.id });
        expect(!del.isError, "deleted", textOf(del));
        const listed = structured<Listed>(await call("list", { tags: ["kept"] }));
        expect(!listed.files.some((f) => f.id === png.id), "not listed", listed);
        const read = await call("read", { id: png.id });
        expect(read.isError, "read refused", textOf(read));
        const dl = await t.client.rest(t.alice, "GET", `/v1/workspaces/${t.ws}/files/${png.id}`);
        expectEq(dl.status, 404, "download");
        return { read: textOf(read).slice(0, 120), download: dl.status };
      },
    );

    // Inventory FI-15 (unknown): errors are {code, error} with closed codes.
    await t.check("FI-15", "a failing call answers {code, error}", async () => {
      const r = await call("info", { id: "file_missing0000" });
      const body = structured<{ code?: string; error?: string }>(r);
      expect(r.isError, "an error", r);
      expect(
        typeof body.code === "string" && typeof body.error === "string",
        "{code, error}",
        textOf(r),
      );
      return body;
    });

    // Inventory FI-7 (unknown): a 4 MiB decoded cap and the type allowlist on create.
    await t.check("FI-7", "create refuses a body over 4 MiB and a disallowed type", async () => {
      const big = await call("create", {
        manifest: { filename: "big.txt", mimeType: "text/plain" },
        body: "a".repeat(4 * 1024 * 1024 + 1),
        encoding: "text",
      });
      const sh = await call("create", {
        manifest: { filename: "x.sh", mimeType: "application/x-sh" },
        body: "echo hi",
        encoding: "text",
      });
      expect(big.isError, "4 MiB + 1 refused", textOf(big).slice(0, 200));
      expect(sh.isError, "application/x-sh refused", textOf(sh));
      return { big: textOf(big).slice(0, 200), sh: textOf(sh).slice(0, 200) };
    });
  },
};

export const filesInChat: Scenario = {
  id: "files.chat-link",
  title: "A file an agent writes in chat carries a download link that serves it",
  covers: ["FI-35", "NEW-FI-1"],
  requires: ["scripted-model"],
  async run(t) {
    const turn = await t.client.turn(t.alice, t.ws, {
      message: `write it ${directive({
        steps: [
          [
            {
              tool: "files__create",
              args: {
                manifest: { filename: "from-chat.md", mimeType: "text/markdown" },
                body: `chat ${MARK.txt}`,
                encoding: "text",
              },
            },
          ],
        ],
        reply: "written",
      })}`,
    });

    await t.check(
      "NEW-FI-1",
      "the stored tool call carries a files:// link the download door serves",
      async () => {
        expectEq(turn.end, "done", "the turn");
        const got = structured<{
          messages: Array<{
            toolCalls?: Array<{
              name: string;
              resourceLinks?: Array<{ uri: string }>;
              result?: unknown;
            }>;
          }>;
        }>(
          await t.client.tool(t.alice, t.ws, "conversations__get", {
            id: turn.conversationId,
            expand: "full",
          }),
        );
        const created = got.messages
          .flatMap((m) => m.toolCalls ?? [])
          .filter((c) => c.name === "files__create")
          .at(-1);
        const uri = created?.resourceLinks?.find((l) => l.uri.startsWith("files://"))?.uri;
        expect(uri, "a files:// resource link on the tool call", created);
        const dl = await t.client.rest(
          t.alice,
          "GET",
          `/v1/workspaces/${t.ws}/files/${uri.slice("files://".length)}`,
        );
        expectEq(dl.status, 200, "download");
        expect(dl.text.includes(MARK.txt), "the bytes", dl.text);
        return { uri, download: dl.status };
      },
    );

    await t.check(
      "FI-35",
      "list by conversationId gives only the files of that conversation",
      async () => {
        const listed = structured<Listed>(
          await t.client.tool(t.alice, t.ws, "files__list", {
            conversationId: turn.conversationId,
          }),
        );
        expectEq(
          listed.files.map((f) => f.filename),
          ["from-chat.md"],
          "the turn's file",
        );
        return listed.files;
      },
    );
  },
};

export const filesOwnerWall: Scenario = {
  id: "files.owner-wall",
  title: "Two members of one workspace never see each other's files",
  covers: ["FI-36"],
  requires: ["org-admin", "second-identity"],
  async run(t) {
    const bob = t.bob;
    if (!bob) throw new Error("no second identity");
    const created = structured<{ id: string }>(
      await t.client.identityTool(t.alice, "nb__manage_workspaces", {
        action: "create",
        name: "Parity shared",
      }),
    );
    const ws = (created as { id?: string; workspace?: { id: string } }).workspace?.id ?? created.id;
    const bootBob = await t.client.bootstrap(bob);
    const bobId = bootBob.user.id;
    await t.client.identityTool(t.alice, "nb__manage_workspaces", {
      action: "add_member",
      workspaceId: ws,
      userId: bobId,
      role: "member",
    });
    const file = structured<{ id: string }>(
      await t.client.tool(t.alice, ws, "files__create", {
        manifest: { filename: "alice.txt", mimeType: "text/plain" },
        body: "alice only",
        encoding: "text",
      }),
    );

    await t.check(
      "FI-36",
      "Bob, in the same workspace, cannot list, read or download Alice's file",
      async () => {
        expect(file.id, "alice's file", file);
        const listed = structured<Listed>(await t.client.tool(bob, ws, "files__list", {}));
        expect(!listed.files.some((f) => f.id === file.id), "not in bob's list", listed);
        const read = await t.client.tool(bob, ws, "files__read", { id: file.id });
        expect(read.isError, "read refused", textOf(read));
        const dl = await t.client.rest(bob, "GET", `/v1/workspaces/${ws}/files/${file.id}`);
        expectEq(dl.status, 404, "download");
        return { ws, list: listed.total, read: textOf(read).slice(0, 120), download: dl.status };
      },
    );
  },
};
