/**
 * An in-memory `FilesHost`: the files contract's calls the kernel makes, over
 * a map of records and bodies walled by workspace and owner, with a transfer
 * client that streams those bodies. For unit tests of the kernel's file doors
 * without a plugin process; the real plugin is exercised by the integration
 * tests (`files-plugin-default.test.ts`).
 */

import type { FilesHost, OwnerScope, Resolved } from "../../src/files/host.ts";
import type { TransferClient } from "../../src/files/transfer.ts";
import type { FileRecord } from "../../src/files/types.ts";

interface Stored {
  record: FileRecord;
  body: Uint8Array;
  workspaceId: string;
  ownerId: string;
}

export interface FakeFilesHost extends FilesHost {
  /** Store a file for an owner; answers its record. */
  seed(
    scope: OwnerScope,
    file: { filename: string; mimeType: string; body: Uint8Array | string; tags?: string[] },
  ): FileRecord;
  /** Every call the kernel made, in order: tool name and scope. */
  calls: Array<{ tool: string; scope: OwnerScope; args?: unknown }>;
  /** Text `read` answers by id; absent ids answer `extractedText: null`. */
  texts: Map<string, string>;
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (bytes.byteLength > 0) c.enqueue(bytes);
      c.close();
    },
  });
}

export function createFakeFilesHost(): FakeFilesHost {
  const files = new Map<string, Stored>();
  const uploads = new Map<
    string,
    { scope: OwnerScope; args: Record<string, unknown>; body?: Uint8Array }
  >();
  const calls: FakeFilesHost["calls"] = [];
  const texts = new Map<string, string>();
  let next = 0;

  const visible = (scope: OwnerScope, id: string): Stored | undefined => {
    const f = files.get(id);
    return f && f.workspaceId === scope.workspaceId && f.ownerId === scope.ownerId ? f : undefined;
  };

  const transfer: TransferClient = {
    async download(url, expect) {
      const id = url.replace("fake://download/", "");
      const f = files.get(id);
      if (!f) throw new Error("gone");
      const body = expect.range
        ? f.body.subarray(expect.range.start, expect.range.end + 1)
        : f.body;
      return {
        status: expect.range ? 206 : 200,
        length: body.byteLength,
        ...(expect.range
          ? { contentRange: `bytes ${expect.range.start}-${expect.range.end}/${f.body.byteLength}` }
          : {}),
        body: stream(body),
      };
    },
    async upload(url, upload) {
      const id = url.replace("fake://upload/", "");
      const open = uploads.get(id);
      if (!open) throw new Error("no upload");
      open.body = new Uint8Array(await new Response(upload.body).arrayBuffer());
    },
  };

  function seed(
    scope: OwnerScope,
    file: { filename: string; mimeType: string; body: Uint8Array | string; tags?: string[] },
  ): FileRecord {
    const id = `fl_${String(++next).padStart(24, "0")}`;
    const body = typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
    const record: FileRecord = {
      id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: body.byteLength,
      tags: file.tags ?? [],
      source: "agent",
      conversationId: scope.conversationId ?? null,
      runId: scope.runId ?? null,
      createdAt: new Date().toISOString(),
      description: null,
    };
    files.set(id, { record, body, workspaceId: scope.workspaceId, ownerId: scope.ownerId });
    return record;
  }

  return {
    hostVersion: "1.0",
    transfer,
    calls,
    texts,
    seed,
    async beginUpload(scope, args) {
      calls.push({ tool: "begin_upload", scope, args });
      const uploadId = `up_${++next}`;
      uploads.set(uploadId, { scope, args });
      return {
        uploadId,
        url: `fake://upload/${uploadId}`,
        method: "PUT",
        headers: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    async completeUpload(scope, uploadId) {
      calls.push({ tool: "complete_upload", scope });
      const open = uploads.get(uploadId);
      if (!open?.body) throw Object.assign(new Error("incomplete"), { code: "upload_incomplete" });
      const args = open.args as { filename: string; mimeType: string; source: string };
      const record = seed(open.scope, {
        filename: args.filename,
        mimeType: args.mimeType,
        body: open.body,
      });
      record.source = args.source;
      return { uri: `files://${record.id}`, file: record };
    },
    async resolve(scope, uris) {
      calls.push({ tool: "resolve", scope, args: uris });
      return uris.map((uri): Resolved => {
        const f = visible(scope, uri.replace("files://", ""));
        return f
          ? {
              uri,
              found: true,
              file: f.record,
              download: { url: `fake://download/${f.record.id}`, expiresAt: "" },
            }
          : { uri, found: false };
      });
    },
    async read(scope, id, maxBytes) {
      calls.push({ tool: "read", scope, args: { id, maxBytes } });
      const f = visible(scope, id);
      if (!f) throw Object.assign(new Error("absent"), { code: "file_not_found" });
      const text = texts.get(id);
      return {
        id,
        filename: f.record.filename,
        mimeType: f.record.mimeType,
        size: f.record.size,
        extractedText: text === undefined ? null : text.slice(0, maxBytes),
        truncated: text !== undefined && text.length > maxBytes,
      };
    },
    async list(scope, args) {
      calls.push({ tool: "list", scope, args });
      const mine = [...files.values()]
        .filter((f) => f.workspaceId === scope.workspaceId && f.ownerId === scope.ownerId)
        .map((f) => f.record);
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const start = typeof args.cursor === "string" ? Number(args.cursor) : 0;
      const page = mine.slice(start, start + limit);
      const end = start + page.length;
      return {
        files: page,
        nextCursor: end < mine.length ? String(end) : null,
        total: mine.length,
      };
    },
    async delete(scope, id) {
      calls.push({ tool: "delete", scope, args: { id } });
      if (visible(scope, id)) files.delete(id);
    },
  };
}
