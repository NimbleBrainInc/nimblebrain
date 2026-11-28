/**
 * The private tools: the host's alone (CONTRACT.md §6). Bytes move by the transfer URLs
 * `transfer.ts` issues; these tools open uploads, make files from what arrived, answer where
 * to fetch a file, and purge a workspace.
 */

import { privateError } from "./contract.ts";
import { ensureFolderPath, pathSegments } from "./folders.ts";
import { isAllowed, recordedType } from "./mime.ts";
import type { Caller, Env } from "./public.ts";
import { fileRecord } from "./query.ts";
import { type FileRow, mintId, type UploadRow, type WorkspaceState } from "./store.ts";
import type { Transfers } from "./transfer.ts";

/**
 * How long after an upload URL's `expiresAt` a body whose PUT began in time can still be
 * completed, and a completed upload's answer is repeated (CONTRACT.md §6, §12).
 */
export const COMPLETION_GRACE_MS = 300_000;
/** The longest a download URL lives, and an upload URL (CONTRACT.md §7). */
export const MAX_DOWNLOAD_TTL_MS = 300_000;
export const MAX_UPLOAD_TTL_MS = 900_000;
/** The default per-file limit on an upload: 25 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 26_214_400;

export interface PrivateEnv extends Env {
  transfers: Transfers;
  uploadTtlMs: number;
  downloadTtlMs: number;
  maxFileBytes: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const FILE_URI = /^files:\/\/([a-z0-9][a-z0-9_-]{0,63})$/;

interface BeginArgs {
  version: string;
  filename: string;
  mimeType: string;
  size: number;
  source: string;
  folder?: string;
  tags?: string[];
  description?: string;
}

export function beginUpload(env: PrivateEnv, caller: Caller, args: BeginArgs) {
  const mimeType = recordedType(args.filename, args.mimeType);
  if (!isAllowed(mimeType)) throw privateError("type_not_allowed", `${mimeType} is not allowed`);
  if (args.size > env.maxFileBytes) {
    throw privateError("too_large", `${args.size} bytes is over the ${env.maxFileBytes} limit`);
  }
  let folder: string | null = null;
  if (args.folder !== undefined && args.folder !== "") {
    try {
      pathSegments("begin_upload", args.folder);
    } catch (err) {
      throw privateError("invalid_input", err instanceof Error ? err.message : String(err));
    }
    folder = args.folder;
  }
  const expiresAt = env.now() + env.uploadTtlMs;
  const upload: UploadRow = {
    id: mintId("up"),
    ownerId: caller.ownerId,
    filename: args.filename,
    mimeType,
    size: args.size,
    source: args.source,
    folder,
    tags: [...new Set(args.tags ?? [])],
    description: args.description ?? null,
    conversationId: caller.conversationId,
    runId: caller.runId,
    expiresAt,
  };
  env.store.openUpload(caller.workspaceId, upload);
  return {
    uploadId: upload.id,
    url: env.transfers.issueUpload(caller.workspaceId, caller.ownerId, upload.id, expiresAt),
    method: "PUT",
    headers: {},
    expiresAt: iso(expiresAt),
  };
}

const uploadNotFound = (id: string) =>
  privateError("upload_not_found", `no open upload ${id} in scope`);

const pastWindow = (expiresAt: number, now: number) => now > expiresAt + COMPLETION_GRACE_MS;

/**
 * A repeat's answer: the first `{ uri, file }`, rebuilt from the file's row with the fields
 * kept from when the upload completed, while the file exists in the caller's scope.
 */
function repeatAnswer(state: WorkspaceState, caller: Caller, uploadId: string, now: number) {
  const done = Object.hasOwn(state.completed, uploadId) ? state.completed[uploadId] : undefined;
  if (!done || pastWindow(done.expiresAt, now)) return null;
  const row = Object.hasOwn(state.files, done.fileId) ? state.files[done.fileId] : undefined;
  if (!row || row.ownerId !== caller.ownerId) throw uploadNotFound(uploadId);
  const first = { ...row, tags: done.tags, folderId: done.folderId };
  return { uri: `files://${row.id}`, file: fileRecord(first, caller.workspaceId) };
}

/** The measured length of the upload's stored body, or `upload_incomplete`. */
function measured(env: PrivateEnv, workspaceId: string, upload: UploadRow): number {
  const size = env.store.uploadBodySize(workspaceId, upload.id);
  if (size === upload.size) return size;
  throw privateError(
    "upload_incomplete",
    size === null
      ? `no body is stored for upload ${upload.id}`
      : `the stored body is ${size} bytes, not the declared ${upload.size}`,
  );
}

export function completeUpload(env: PrivateEnv, caller: Caller, args: { uploadId: string }) {
  const now = env.now();
  const { workspaceId } = caller;
  const repeat = env.store.view(workspaceId, (s) => repeatAnswer(s, caller, args.uploadId, now));
  if (repeat) return repeat;
  const upload = env.store.upload(workspaceId, args.uploadId);
  if (!upload || upload.ownerId !== caller.ownerId || pastWindow(upload.expiresAt, now)) {
    throw uploadNotFound(args.uploadId);
  }
  const size = measured(env, workspaceId, upload);
  const answer = env.store.mutate(workspaceId, (tx) => {
    const createdAt = iso(now);
    const segments = upload.folder ? pathSegments("begin_upload", upload.folder) : [];
    const row: FileRow = {
      id: mintId("fl"),
      ownerId: caller.ownerId,
      filename: upload.filename,
      mimeType: upload.mimeType,
      size,
      tags: upload.tags,
      source: upload.source,
      conversationId: upload.conversationId,
      runId: upload.runId,
      createdAt,
      description: upload.description,
      folderId: ensureFolderPath(tx.state, caller.ownerId, segments, createdAt),
    };
    tx.state.files[row.id] = row;
    tx.state.completed[upload.id] = {
      fileId: row.id,
      expiresAt: upload.expiresAt,
      tags: [...row.tags],
      folderId: row.folderId,
    };
    tx.adoptUploadBody(upload.id, row.id);
    tx.dropUploadBody(upload.id);
    return { uri: `files://${row.id}`, file: fileRecord(row, workspaceId) };
  });
  env.store.closeUpload(workspaceId, upload.id);
  env.transfers.revokeUpload(workspaceId, upload.id);
  return answer;
}

export function resolveUris(env: PrivateEnv, caller: Caller, args: { uris: string[] }) {
  const expiresAt = env.now() + env.downloadTtlMs;
  const files = env.store.view(caller.workspaceId, (s) =>
    args.uris.map((uri) => {
      const id = FILE_URI.exec(uri)?.[1];
      const row = id && Object.hasOwn(s.files, id) ? s.files[id] : undefined;
      if (!row || row.ownerId !== caller.ownerId) return { uri, found: false as const };
      return {
        uri,
        found: true as const,
        file: fileRecord(row, caller.workspaceId),
        download: {
          url: env.transfers.issueDownload(caller.workspaceId, caller.ownerId, row.id, expiresAt),
          expiresAt: iso(expiresAt),
        },
      };
    }),
  );
  return { files };
}

export function deleteWorkspace(env: PrivateEnv, caller: Pick<Caller, "workspaceId">) {
  const removed = env.store.view(caller.workspaceId, (s) => ({
    files: Object.keys(s.files).length,
    folders: Object.keys(s.folders).length,
  }));
  env.transfers.revokeWorkspace(caller.workspaceId);
  env.store.removeWorkspace(caller.workspaceId);
  return { removed };
}

/**
 * Retire uploads past their completion window: an abandoned one with its bytes, a completed
 * one's repeatable answer. Nothing is committed for it (`Store.retireUploads`).
 */
export function sweepUploads(env: Env, workspaceId: string): void {
  const now = env.now();
  env.store.retireUploads(workspaceId, (expiresAt) => pastWindow(expiresAt, now));
}
