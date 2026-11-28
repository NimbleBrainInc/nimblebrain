/**
 * The one intake every door takes files in through (`contracts/files/CONTRACT.md`
 * §10.2): a chat turn's attachments, an upload at the REST door, and the app
 * bridge's uploads, which reach the same REST door.
 *
 * - Every check the host can make runs before any upload opens: the count,
 *   each body's size, the total, and the allowlist.
 * - Each body is `begin_upload` as `host` walled to the workspace and the
 *   uploader (with the turn's conversation in the context), its exact size
 *   streamed to the upload URL, then `complete_upload`.
 * - The REST door takes each file in, or refuses it, on its own
 *   ({@link takeInFile}). A chat turn is all or none ({@link takeInTurn}).
 */

import { log } from "../observability/log.ts";
import { ContractToolError } from "../plugins/bound-servers.ts";
import type { FilesHost, OwnerScope } from "./host.ts";
import { humanSize } from "./human-size.ts";
import { bareType, GENERIC_BINARY, IMAGE_TYPES, isAllowedType, PDF_TYPE } from "./mime.ts";
import type { ContentPart, FileRecord, FileReference } from "./types.ts";
import { fileIdToUri } from "./uri.ts";

/** A body a door received, measured, ready to stream. */
export interface IntakeBody {
  filename: string;
  /** The type the sender named; empty when it named none. */
  mimeType: string;
  size: number;
  /** A fresh stream of exactly `size` bytes. */
  open(): ReadableStream<Uint8Array>;
}

export interface IntakeLimits {
  maxFiles: number;
  maxFileSize: number;
  maxTotalSize: number;
}

/** The type the intake records a body under: as sent, or `application/octet-stream` when none was. */
export function intakeType(file: Pick<IntakeBody, "mimeType">): string {
  const sent = file.mimeType.trim();
  return sent === "" ? GENERIC_BINARY : sent;
}

/** Why one body is refused before any upload opens, or null. */
export function fileRefusal(file: IntakeBody, maxFileSize: number): string | null {
  if (file.size > maxFileSize) {
    return `File "${file.filename}" (${humanSize(file.size)}) exceeds per-file limit of ${humanSize(maxFileSize)}`;
  }
  if (!isAllowedType(intakeType(file))) {
    return `File "${file.filename}" has disallowed type: ${intakeType(file)}`;
  }
  return null;
}

/** The refusals of a request as a whole: its count and its total. */
export function requestRefusals(files: readonly IntakeBody[], limits: IntakeLimits): string[] {
  if (files.length > limits.maxFiles) {
    return [`Too many files: ${files.length} exceeds the limit of ${limits.maxFiles}`];
  }
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > limits.maxTotalSize) {
    return [
      `Total file size ${humanSize(total)} exceeds the limit of ${humanSize(limits.maxTotalSize)}`,
    ];
  }
  return [];
}

/** What the uploader adds to a file at a door that takes metadata. */
export interface IntakeMeta {
  source: "chat" | "app" | "manual";
  tags?: string[];
  description?: string;
}

/**
 * An intake that failed past its checks. Its message is safe to show.
 * `unavailable` when the plugin did not refuse the file but was not reached
 * (not running, restarting, a transfer cut off): the same file may be sent again.
 */
export class IntakeError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
    this.name = "IntakeError";
  }
}

async function begin(host: FilesHost, scope: OwnerScope, file: IntakeBody, meta: IntakeMeta) {
  return host.beginUpload(scope, {
    filename: file.filename,
    mimeType: intakeType(file),
    size: file.size,
    source: meta.source,
    ...(meta.tags && meta.tags.length > 0 ? { tags: meta.tags } : {}),
    ...(meta.description ? { description: meta.description } : {}),
  });
}

/**
 * Why an intake step failed, for the uploader: the plugin's code, never a URL.
 * A failure without one is the plugin not reached, not a refusal.
 */
function failure(file: IntakeBody, err: unknown): IntakeError {
  const code = (err as { code?: unknown })?.code;
  const refused = err instanceof ContractToolError;
  const why =
    code === "too_large"
      ? "is larger than the files plugin accepts"
      : code === "type_not_allowed"
        ? "has a type the files plugin does not accept"
        : refused
          ? "could not be stored"
          : "could not be stored now; try again";
  log.warn("[files] intake failed", {
    filename: file.filename,
    code: typeof code === "string" ? code : "transfer",
    error: err instanceof Error ? err.name : "unknown",
  });
  return new IntakeError(`File "${file.filename}" ${why}`, !refused);
}

/** Take one file in: begin, stream, complete. */
export async function takeInFile(
  host: FilesHost,
  scope: OwnerScope,
  file: IntakeBody,
  meta: IntakeMeta,
): Promise<FileRecord> {
  try {
    const upload = await begin(host, scope, file, meta);
    await host.transfer.upload(upload.url, {
      headers: upload.headers,
      size: file.size,
      body: file.open(),
    });
    return (await host.completeUpload(scope, upload.uploadId)).file;
  } catch (err) {
    throw failure(file, err);
  }
}

/**
 * Take a chat turn's files in, all or none: every upload opened, then every
 * body streamed, then every upload completed. If any step fails, each file
 * already completed is deleted (`delete` as `host`, walled to the uploader),
 * and the error is thrown; the uploads never completed expire.
 */
export async function takeInTurn(
  host: FilesHost,
  scope: OwnerScope,
  files: readonly IntakeBody[],
): Promise<FileRecord[]> {
  const meta: IntakeMeta = { source: "chat" };
  const uploads: Array<Awaited<ReturnType<typeof begin>>> = [];
  for (const file of files) {
    try {
      uploads.push(await begin(host, scope, file, meta));
    } catch (err) {
      throw failure(file, err);
    }
  }
  for (const [i, file] of files.entries()) {
    const upload = uploads[i];
    if (!upload) continue;
    try {
      await host.transfer.upload(upload.url, {
        headers: upload.headers,
        size: file.size,
        body: file.open(),
      });
    } catch (err) {
      throw failure(file, err);
    }
  }
  const completed: FileRecord[] = [];
  try {
    for (const upload of uploads) {
      completed.push((await host.completeUpload(scope, upload.uploadId)).file);
    }
  } catch (err) {
    for (const file of completed) {
      await host.delete(scope, file.id).catch((e: unknown) => {
        log.warn("[files] could not delete a turn's file after a failed intake", {
          fileId: file.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }
    throw failure(files[completed.length] ?? (files[0] as IntakeBody), err);
  }
  return completed;
}

/** Appended to an attachment's text when `read` stopped at its bound. */
export const TRUNCATED_NOTE = "\n[Text truncated: call files__read for the rest.]";

/**
 * The model's view of a turn's attachments (§10.3): an image or a PDF travels
 * as a `resource_link` to its URI; any other file's text comes from the
 * plugin's `read` as `host`, walled to the uploader, bounded by `maxBytes`. A
 * file with no text is named, with a hint to read it.
 */
export async function attachmentParts(
  host: FilesHost,
  scope: OwnerScope,
  records: readonly FileRecord[],
  maxBytes: number,
): Promise<{ contentParts: ContentPart[]; fileRefs: FileReference[] }> {
  const contentParts: ContentPart[] = [];
  const fileRefs: FileReference[] = [];
  for (const file of records) {
    const bare = bareType(file.mimeType);
    let extracted = false;
    if (IMAGE_TYPES.has(bare) || bare === PDF_TYPE) {
      contentParts.push({
        type: "resource_link",
        uri: fileIdToUri(file.id),
        mimeType: file.mimeType,
        name: file.filename,
      });
    } else {
      const read = await host.read(scope, file.id, maxBytes).catch(() => null);
      const label = `${file.filename} (${file.id}, ${humanSize(file.size)})`;
      if (read && typeof read.extractedText === "string") {
        extracted = true;
        contentParts.push({
          type: "text",
          text: `--- Attached: ${label} ---\n${read.extractedText}${read.truncated ? TRUNCATED_NOTE : ""}`,
        });
      } else {
        contentParts.push({
          type: "text",
          text: `--- Attached: ${label} — binary file, use files__read to access ---`,
        });
      }
    }
    fileRefs.push({
      id: file.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      extracted,
    });
  }
  return { contentParts, fileRefs };
}
