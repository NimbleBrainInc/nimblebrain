/**
 * The HTTP doors that take files in and serve them out, over the one kernel
 * intake (`src/files/intake.ts`) and the files contract's `resolve`
 * (`contracts/files/CONTRACT.md` §10):
 *
 * - a chat turn's attachments (multipart `POST …/chat/start`), all or none;
 * - `POST /v1/workspaces/:wsId/resources`, the REST and app-bridge upload, per file;
 * - `GET /v1/workspaces/:wsId/files/:fileId`, the browser download;
 * - `resources/read` of a `files://` URI, at the REST read and the MCP door.
 *
 * With no plugin implementing the contract, every one answers that files are
 * disabled.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CONVERSATION_ID_RE } from "../conversation/types.ts";
import type { FilesHost, OwnerScope } from "../files/host.ts";
import {
  attachmentParts,
  fileRefusal,
  type IntakeBody,
  IntakeError,
  type IntakeMeta,
  requestRefusals,
  takeInFile,
  takeInTurn,
} from "../files/intake.ts";
import { isTextMime } from "../files/mime.ts";
import {
  MultipartError,
  multipartBoundary,
  type ParsedMultipart,
  parseMultipart,
} from "../files/multipart.ts";
import { FileTooLargeError, readFileBody } from "../files/serve.ts";
import type { ContentPart, FileRecord, FileReference } from "../files/types.ts";
import { FILE_ID_RE, fileIdToUri, uriToFileId } from "../files/uri.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { log } from "../observability/log.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { ResourceData } from "../tools/types.ts";
import { serveFileDownload } from "./file-serve.ts";
import type { UploadResourceResponse } from "./schemas/responses.ts";
import { apiError, json } from "./types.ts";

/** The answer of a file door while no plugin implements the files contract. */
export function filesDisabledResponse(): Response {
  return apiError(404, "files_disabled", "Files are disabled on this instance");
}

/** Where a request's file parts are spooled while the intake measures and streams them. */
function spoolDir(runtime: Runtime): string {
  return join(runtime.getWorkDir(), "tmp", "intake");
}

/** Room for a multipart body's own framing and text fields beside its files. */
const MULTIPART_OVERHEAD_BYTES = 1_048_576;

/** Read a multipart request, spooling its files, or the refusal. */
export async function readMultipart(
  request: Request,
  runtime: Runtime,
  opts: { maxFiles: number; fileFields?: ReadonlySet<string> },
): Promise<ParsedMultipart | Response> {
  const boundary = multipartBoundary(request.headers.get("content-type"));
  if (!boundary) return apiError(400, "bad_request", "Invalid multipart form data");
  const config = runtime.getFilesConfig();
  try {
    return await parseMultipart(request.body, boundary, {
      spoolDir: spoolDir(runtime),
      maxFiles: opts.maxFiles,
      maxFileSize: config.maxFileSize,
      maxTotalSize: config.maxTotalSize + MULTIPART_OVERHEAD_BYTES,
      ...(opts.fileFields ? { fileFields: opts.fileFields } : {}),
    });
  } catch (err) {
    if (err instanceof MultipartError) {
      return err.status === 413
        ? apiError(413, "payload_too_large", err.message)
        : apiError(400, "bad_request", err.message);
    }
    throw err;
  }
}

/** The spooled files of a request as intake bodies, each streamed from its spool file. */
function intakeBodies(parsed: ParsedMultipart): IntakeBody[] {
  return parsed.files.map((f) => ({
    filename: f.filename || "unnamed",
    mimeType: f.mimeType,
    size: f.size,
    open: () => {
      if (!f.path) throw new IntakeError(`File "${f.filename}" was not kept`);
      return Bun.file(f.path).stream();
    },
  }));
}

/** A fresh conversation id, in the shape the conversations contract takes. */
export function mintConversationId(): string {
  return `conv_${randomBytes(8).toString("hex")}`;
}

/** What a chat turn's attachments add to its request. */
export interface TurnAttachments {
  contentParts: ContentPart[];
  fileRefs: FileReference[];
  /** The id the turn's new conversation is created with, when the turn has none yet. */
  newConversationId?: string;
}

/**
 * Take a chat turn's attachments in, all or none (§10.2). `conversationId` is
 * the turn's verified conversation; with none, one is minted first so every
 * file's record names the conversation it was attached in.
 */
export async function takeInTurnAttachments(
  runtime: Runtime,
  parsed: ParsedMultipart,
  opts: { workspaceId: string; identity: UserIdentity | undefined; conversationId?: string },
): Promise<TurnAttachments | Response> {
  const host = runtime.getFiles();
  if (!host) return filesDisabledResponse();
  const bodies = intakeBodies(parsed);
  const config = runtime.getFilesConfig();
  const errors = [
    ...requestRefusals(bodies, {
      maxFiles: config.maxFilesPerMessage,
      maxFileSize: config.maxFileSize,
      maxTotalSize: config.maxTotalSize,
    }),
  ];
  if (errors.length === 0) {
    for (const body of bodies) {
      const why = fileRefusal(body, config.maxFileSize);
      if (why) errors.push(why);
    }
  }
  if (errors.length > 0) {
    return apiError(400, "file_upload_error", "File upload failed", { errors });
  }
  const ownerId = runtime.resolveRequestUserId(opts.identity);
  const newConversationId = opts.conversationId ? undefined : mintConversationId();
  const scope: OwnerScope = {
    workspaceId: opts.workspaceId,
    ownerId,
    conversationId: (opts.conversationId ?? newConversationId) as string,
  };
  let records: FileRecord[];
  try {
    records = await takeInTurn(host, scope, bodies);
  } catch (err) {
    if (err instanceof IntakeError) {
      return apiError(400, "file_upload_error", "File upload failed", { errors: [err.message] });
    }
    throw err;
  } finally {
    runtime.announceFilesChange(ownerId);
  }
  const parts = await attachmentParts(host, scope, records, runtime.getFileReadMaxBytes());
  return { ...parts, ...(newConversationId ? { newConversationId } : {}) };
}

/**
 * Files one store upload may carry. An upload adds files to the store and makes
 * no chat message, so `maxFilesPerMessage` (a bound on one model turn's
 * attachments) does not apply; bytes are bounded by `maxTotalSize`, and this
 * caps the per-file writes a request of many tiny parts can cause.
 */
export const MAX_FILES_PER_UPLOAD = 100;

const UPLOAD_FILE_FIELDS: ReadonlySet<string> = new Set(["file", "files"]);

/** Parse the optional `tags` field as a JSON array of strings ([] when absent), or an error Response. */
function parseTags(raw: string | undefined): string[] | Response {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
      return apiError(400, "bad_request", "tags must be a JSON array of strings");
    }
    return parsed;
  } catch {
    return apiError(400, "bad_request", "tags must be a valid JSON array");
  }
}

/** The refusal of an upload as a whole (no files, too many, over the total), or null. */
function uploadRefusal(bodies: readonly IntakeBody[], maxTotalSize: number): Response | null {
  if (bodies.length === 0) {
    return apiError(400, "bad_request", "No files in request (use the 'file' or 'files' field)");
  }
  if (bodies.length > MAX_FILES_PER_UPLOAD) {
    return apiError(
      413,
      "payload_too_large",
      `Too many files: ${bodies.length} in one upload; the limit is ${MAX_FILES_PER_UPLOAD}.`,
      { count: bodies.length, limit: MAX_FILES_PER_UPLOAD },
    );
  }
  const total = bodies.reduce((sum, f) => sum + f.size, 0);
  if (total > maxTotalSize) {
    return apiError(413, "payload_too_large", "Upload is over the size limit", {
      size: total,
      limit: maxTotalSize,
    });
  }
  return null;
}

/** An upload's metadata fields (`tags`, `description`, `conversationId`), or the refusal. */
function uploadMeta(
  fields: ReadonlyMap<string, string>,
): { tags: string[]; description?: string; conversationId?: string } | Response {
  const tags = parseTags(fields.get("tags"));
  if (tags instanceof Response) return tags;
  const description = fields.get("description") || undefined;
  const conversationId = fields.get("conversationId") || undefined;
  if (conversationId !== undefined && !CONVERSATION_ID_RE.test(conversationId)) {
    return apiError(400, "bad_request", "Invalid conversationId format");
  }
  return {
    tags,
    ...(description ? { description } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
}

/** Take each body in on its own: the stored records, and why each refused one was. */
async function takeInEach(
  host: FilesHost,
  scope: OwnerScope,
  bodies: readonly IntakeBody[],
  meta: IntakeMeta,
  maxFileSize: number,
): Promise<{ files: FileRecord[]; errors: string[] }> {
  const files: FileRecord[] = [];
  const errors: string[] = [];
  for (const body of bodies) {
    const why = fileRefusal(body, maxFileSize);
    if (why) {
      errors.push(why);
      continue;
    }
    try {
      files.push(await takeInFile(host, scope, body, meta));
    } catch (err) {
      if (!(err instanceof IntakeError)) throw err;
      errors.push(err.message);
    }
  }
  return { files, errors };
}

/**
 * `POST /v1/workspaces/:wsId/resources`: take each file under `file` or
 * `files` in on its own, with the optional `tags`, `description` and
 * `conversationId` applied to each. `refuseConversation` answers a
 * `conversationId` that is not the caller's in this workspace.
 */
export async function handleUpload(
  request: Request,
  runtime: Runtime,
  opts: {
    workspaceId: string;
    identity: UserIdentity | undefined;
    refuseConversation: (conversationId: string | undefined) => Promise<Response | null>;
  },
): Promise<Response> {
  const host = runtime.getFiles();
  if (!host) return filesDisabledResponse();
  const parsed = await readMultipart(request, runtime, {
    maxFiles: MAX_FILES_PER_UPLOAD,
    fileFields: UPLOAD_FILE_FIELDS,
  });
  if (parsed instanceof Response) return parsed;
  try {
    const bodies = intakeBodies(parsed);
    const config = runtime.getFilesConfig();
    const refused = uploadRefusal(bodies, config.maxTotalSize);
    if (refused) return refused;
    const meta = uploadMeta(parsed.fields);
    if (meta instanceof Response) return meta;
    const outside = await opts.refuseConversation(meta.conversationId);
    if (outside) return outside;

    const ownerId = runtime.resolveRequestUserId(opts.identity);
    const scope: OwnerScope = {
      workspaceId: opts.workspaceId,
      ownerId,
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    };
    const { files, errors } = await takeInEach(
      host,
      scope,
      bodies,
      {
        source: "app",
        tags: meta.tags,
        ...(meta.description ? { description: meta.description } : {}),
      },
      config.maxFileSize,
    );
    if (files.length === 0) {
      return apiError(400, "file_upload_error", "All uploads were rejected", { errors });
    }
    runtime.announceFilesChange(ownerId);
    return json<UploadResourceResponse>({ files, ...(errors.length > 0 ? { errors } : {}) });
  } finally {
    await parsed.dispose();
  }
}

/** `GET /v1/workspaces/:wsId/files/:fileId`: the caller's own file in this workspace, or 404. */
export async function handleFileDownload(
  request: Request,
  runtime: Runtime,
  opts: { workspaceId: string; identity: UserIdentity | undefined; fileId: string },
): Promise<Response> {
  const host = runtime.getFiles();
  if (!host) return filesDisabledResponse();
  if (!FILE_ID_RE.test(opts.fileId)) return apiError(400, "bad_request", "Invalid file ID format");
  const scope: OwnerScope = {
    workspaceId: opts.workspaceId,
    ownerId: runtime.resolveRequestUserId(opts.identity),
  };
  try {
    return await serveFileDownload(host, scope, opts.fileId, request.headers.get("range"));
  } catch (err) {
    log.warn("[files] resolving a download failed", {
      fileId: opts.fileId,
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError(502, "file_unavailable", "The file could not be read");
  }
}

/** Why a `files://` read was not answered with a body. */
export type FileResourceMiss = "disabled" | "not_found" | "too_large" | "unavailable";

/**
 * `resources/read` of a `files://` URI, answered by the host whichever source
 * the read names (the plugin never answers one): `resolve` as `host` with the
 * caller's workspace and owner, then the body from its download URL. Text
 * types as `text`, the rest as `blob`.
 */
export async function readFileResource(
  runtime: Runtime,
  uri: string,
  scope: OwnerScope,
): Promise<ResourceData | FileResourceMiss> {
  const host = runtime.getFiles();
  if (!host) return "disabled";
  if (!uriToFileId(uri)) return "not_found";
  try {
    const got = await readFileBody(host, scope, uri, runtime.getFilesConfig().maxFileSize);
    if (!got) return "not_found";
    return isTextMime(got.file.mimeType)
      ? { mimeType: got.file.mimeType, text: new TextDecoder().decode(got.bytes) }
      : { mimeType: got.file.mimeType, blob: got.bytes };
  } catch (err) {
    if (err instanceof FileTooLargeError) return "too_large";
    log.warn("[files] a resources/read of a file failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "unavailable";
  }
}

/** The most files a door's `resources/list` names. */
export const LISTED_FILES_CAP = 1000;

/**
 * The caller's files as MCP resources, for a door's `resources/list`: the
 * plugin's `list` as `host`, followed page by page up to {@link LISTED_FILES_CAP}.
 * None while files are off, or when the plugin cannot answer.
 */
export async function listFileResources(
  runtime: Runtime,
  scope: OwnerScope,
): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  const host = runtime.getFiles();
  if (!host) return [];
  const out: Array<{ uri: string; name: string; mimeType: string }> = [];
  let cursor: string | null = null;
  try {
    do {
      const page = await host.list(scope, { limit: 200, ...(cursor ? { cursor } : {}) });
      for (const f of page.files ?? []) {
        out.push({ uri: fileIdToUri(f.id), name: f.filename, mimeType: f.mimeType });
      }
      cursor = page.nextCursor ?? null;
    } while (cursor && out.length < LISTED_FILES_CAP);
  } catch (err) {
    log.warn("[files] listing files for a door failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out.slice(0, LISTED_FILES_CAP);
}
