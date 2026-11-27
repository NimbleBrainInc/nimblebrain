/**
 * The public tools: what people and agents call, each walled to the caller's workspace and
 * owner (CONTRACT.md §2, §5, §8). Every handler answers its output's payload, or throws a
 * `ToolCallError` from `contract.ts`.
 */

import { readFileSync } from "node:fs";
import { fileNotFound, invalidInput, publicError } from "./contract.ts";
import { cutText, extractPdfPages, extractText, TEXT_BOUND } from "./extract.ts";
import {
  createFolder,
  deleteFolder,
  ensureFolderPath,
  moveFiles,
  pathSegments,
  updateFolder,
} from "./folders.ts";
import { bareType, hasText, isAllowed, PDF, recordedType } from "./mime.ts";
import { fileRecord, type ListInput, listFiles, type SearchInput, searchFiles } from "./query.ts";
import { type FileRow, mintId, type Store } from "./store.ts";

/** Who a call is for, from its host context. */
export interface Caller {
  workspaceId: string;
  ownerId: string;
  conversationId: string | null;
  runId: string | null;
}

export interface Env {
  store: Store;
  now: () => number;
}

/** The most bytes `create` stores, decoded (CONTRACT.md §7). */
export const MAX_CREATE_BYTES = 4 * 1024 * 1024;
/** The most pages one `read` extracts. */
const MAX_READ_PAGES = 10;

/** The standard base64 alphabet with padding: not base64url. */
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
/** The only whitespace a base64 body may hold: the line breaks a wrapping encoder emits. */
const BASE64_LINE_BREAKS = /[\r\n]+/g;

/**
 * Decode `create`'s body under its encoding. `Buffer.from(s, "base64")` silently drops every
 * character outside the alphabet, so an unencoded body would decode to garbage; it is
 * refused instead, and so are unpadded and base64url bodies, so that padding and alphabet
 * tell base64 from prose. Spaces are not stripped: stripping them turns prose into a
 * candidate.
 */
function decodeBody(body: string, encoding: "base64" | "text"): Buffer {
  if (encoding === "text") return Buffer.from(body, "utf8");
  const compact = body.replace(BASE64_LINE_BREAKS, "");
  if (!BASE64_BODY.test(compact) || compact.length % 4 !== 0) {
    throw invalidInput(
      "create",
      '`body` is not valid base64, and `encoding` defaults to "base64". Expected the standard ' +
        "alphabet (A-Z a-z 0-9 + /) with `=` padding to a multiple of 4; line breaks are " +
        "allowed, other whitespace is not, and base64url (-, _) is not accepted. If `body` is " +
        'content you wrote yourself, pass encoding: "text" and leave it unencoded.',
    );
  }
  return Buffer.from(compact, "base64");
}

function ownRow(env: Env, caller: Caller, id: string): FileRow {
  const row = env.store.view(caller.workspaceId, (s) =>
    Object.hasOwn(s.files, id) ? s.files[id] : undefined,
  );
  if (!row || row.ownerId !== caller.ownerId) throw fileNotFound(id);
  return row;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function list(env: Env, caller: Caller, args: ListInput) {
  return env.store.view(caller.workspaceId, (s) =>
    listFiles(s, caller.workspaceId, caller.ownerId, args),
  );
}

export function search(env: Env, caller: Caller, args: SearchInput) {
  return env.store.view(caller.workspaceId, (s) =>
    searchFiles(s, caller.workspaceId, caller.ownerId, args),
  );
}

export function info(env: Env, caller: Caller, args: { id: string }) {
  return fileRecord(ownRow(env, caller, args.id), caller.workspaceId);
}

export interface ReadAnswer {
  output: Record<string, unknown>;
  row: FileRow;
}

/** `read`: the file's text up to the bound, whole or by page (CONTRACT.md §8). */
export async function read(
  env: Env,
  caller: Caller,
  args: { id: string; pages?: number[]; maxBytes?: number },
): Promise<ReadAnswer> {
  const row = ownRow(env, caller, args.id);
  const bound = Math.min(args.maxBytes ?? TEXT_BOUND, TEXT_BOUND);
  const base = {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
  };
  if (args.pages) {
    if (bareType(row.mimeType) !== PDF) {
      throw publicError("not_paged", `${row.filename} (${row.mimeType}) has no pages`);
    }
    const requestedPages = [...new Set(args.pages)].sort((a, b) => a - b).slice(0, MAX_READ_PAGES);
    const pages = await extractPdfPages(bodyOf(env, caller, row), requestedPages, bound);
    if (!pages) throw publicError("extraction_failed", `${row.id}`);
    return {
      row,
      output: {
        ...base,
        extractedText: null,
        truncated: false,
        totalPages: pages.totalPages,
        requestedPages,
        missingPages: pages.missingPages,
        pages: pages.pages,
      },
    };
  }
  if (!hasText(row.mimeType)) {
    return { row, output: { ...base, extractedText: null, truncated: false } };
  }
  const extracted = await extractText(bodyOf(env, caller, row), row.mimeType);
  if (!extracted) return { row, output: { ...base, extractedText: null, truncated: false } };
  const cut = cutText(extracted.text, bound);
  return {
    row,
    output: { ...base, extractedText: cut.text, truncated: cut.truncated || extracted.truncated },
  };
}

function bodyOf(env: Env, caller: Caller, row: FileRow): Buffer {
  const path = env.store.bodyPath(caller.workspaceId, row.id);
  if (!path) throw new Error(`the body of ${row.id} is missing`);
  return readFileSync(path);
}

interface CreateArgs {
  manifest: {
    filename: string;
    folder?: string;
    mimeType: string;
    tags?: string[];
    description?: string;
  };
  body: string;
  encoding?: "base64" | "text";
}

/** `create`: a new file from the body the caller sends, provenance from the context. */
export function create(env: Env, caller: Caller, args: CreateArgs) {
  const { manifest } = args;
  const data = decodeBody(args.body, args.encoding ?? "base64");
  if (data.length > MAX_CREATE_BYTES) {
    throw publicError(
      "too_large",
      `the body is ${data.length} bytes decoded; create stores at most ${MAX_CREATE_BYTES}`,
    );
  }
  const mimeType = recordedType(manifest.filename, manifest.mimeType);
  if (!isAllowed(mimeType)) throw publicError("type_not_allowed", mimeType);
  const segments = pathSegments("create", manifest.folder ?? "");
  const now = iso(env.now());
  return env.store.mutate(caller.workspaceId, (tx) => {
    const folderId = ensureFolderPath(tx.state, caller.ownerId, segments, now);
    const row: FileRow = {
      id: mintId("fl"),
      ownerId: caller.ownerId,
      filename: manifest.filename,
      mimeType,
      size: data.length,
      tags: [...new Set(manifest.tags ?? [])],
      source: "agent",
      conversationId: caller.conversationId,
      runId: caller.runId,
      createdAt: now,
      description: manifest.description ?? null,
      folderId,
    };
    tx.state.files[row.id] = row;
    tx.putBody(row.id, data);
    return { id: row.id, filename: row.filename, size: row.size, folderId };
  });
}

export function tag(
  env: Env,
  caller: Caller,
  args: { id: string; add?: string[]; remove?: string[] },
) {
  return env.store.mutate(caller.workspaceId, (tx) => {
    const row = tx.state.files[args.id];
    if (!row || row.ownerId !== caller.ownerId) throw fileNotFound(args.id);
    const tags = new Set(row.tags);
    for (const t of args.add ?? []) tags.add(t);
    for (const t of args.remove ?? []) tags.delete(t);
    tx.state.files[row.id] = { ...row, tags: [...tags] };
    return { id: row.id, tags: [...tags] };
  });
}

export function move(env: Env, caller: Caller, args: { ids: string[]; folderId: string }) {
  return env.store.mutate(caller.workspaceId, (tx) => ({
    ids: args.ids,
    folderId: moveFiles(tx.state, caller.ownerId, args.ids, args.folderId),
  }));
}

export function remove(env: Env, caller: Caller, args: { id: string }) {
  return env.store.mutate(caller.workspaceId, (tx) => {
    const row = tx.state.files[args.id];
    if (!row || row.ownerId !== caller.ownerId) throw fileNotFound(args.id);
    delete tx.state.files[row.id];
    tx.dropBody(row.id);
    return { deleted: true };
  });
}

export function createFolderTool(
  env: Env,
  caller: Caller,
  args: { manifest: { name: string; parentId?: string } },
) {
  const now = iso(env.now());
  return env.store.mutate(caller.workspaceId, (tx) =>
    createFolder(tx.state, caller.ownerId, args.manifest, now),
  );
}

export function updateFolderTool(
  env: Env,
  caller: Caller,
  args: { id: string; manifest: { name?: string; parentId?: string } },
) {
  return env.store.mutate(caller.workspaceId, (tx) =>
    updateFolder(tx.state, caller.ownerId, { id: args.id, ...args.manifest }),
  );
}

export function deleteFolderTool(env: Env, caller: Caller, args: { id: string }) {
  return env.store.mutate(caller.workspaceId, (tx) => {
    deleteFolder(tx.state, caller.ownerId, args.id);
    return { deleted: true };
  });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** `read`'s readable rendering: a summary, the text or each page's text. */
export function readText(output: Record<string, unknown>): string {
  const intro = `Read ${output.filename} (${humanSize(Number(output.size))}, ${output.mimeType}).`;
  const pages = output.pages as
    | Array<{ page: number; text: string; truncated: boolean; empty: boolean }>
    | undefined;
  if (pages) {
    const body = pages
      .map(
        (p) => `--- Page ${p.page} ---\n${p.empty ? "[No extractable text on this page]" : p.text}`,
      )
      .join("\n\n");
    const missing = (output.missingPages as number[]).length
      ? `\n\nMissing pages: ${(output.missingPages as number[]).join(", ")} (the PDF has ${output.totalPages}).`
      : "";
    return `${intro} ${output.totalPages} pages.${body ? `\n\n${body}` : ""}${missing}`;
  }
  if (typeof output.extractedText === "string") {
    const cut = output.truncated ? "\n[... truncated: pass `pages` for a PDF's later pages]" : "";
    return `${intro}\n\n--- Extracted text ---\n${output.extractedText}${cut}`;
  }
  return `${intro} No text is available for this file; only its record.`;
}
