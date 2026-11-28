/**
 * A `multipart/form-data` body read as it arrives, for the file intake.
 *
 * The intake checks every file of a request (its count, each size, the total,
 * the allowlist) before it opens any upload, and `begin_upload` needs each
 * body's exact size, which a multipart part does not declare. So each file part
 * is streamed from the request to a spool file of its own and measured as it
 * goes; no body is ever held whole in memory. The intake then streams each
 * spooled body to its upload URL, and the spool is removed when the request is
 * done, whatever its outcome.
 *
 * Bounds hold while streaming: a file past `maxFileSize` stops being written
 * (its size is still counted, so the intake refuses it by name), files past
 * `maxFiles` are counted and not written, and a body past `maxTotalSize`, or a
 * text field past `maxFieldBytes`, ends the read.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { type FileHandle, open, rm } from "node:fs/promises";
import { join } from "node:path";

/** Where a request's file parts are spooled under the runtime's work directory. */
export function intakeSpoolDir(workDir: string): string {
  return join(workDir, "tmp", "intake");
}

/**
 * Remove whatever the spool holds. A request removes its own spool files when it
 * ends, so anything here at boot was left by a process that stopped mid-request.
 * Runs once at boot, after the work directory's lock is held: one process owns
 * a work directory, so no request of another is reading these.
 */
export function sweepIntakeSpool(workDir: string): void {
  rmSync(intakeSpoolDir(workDir), { recursive: true, force: true });
}

/** A file part, spooled. */
export interface SpooledFile {
  /** The form field it came under. */
  field: string;
  filename: string;
  /** The part's `Content-Type`, as sent (empty when it sent none). */
  mimeType: string;
  /** Its length in bytes, counted while it streamed. */
  size: number;
  /** Where its body is, when it was written: absent past a bound. */
  path?: string;
}

export interface ParsedMultipart {
  /** Text fields, by name; the last value of a repeated name wins. */
  fields: Map<string, string>;
  files: SpooledFile[];
  /** Remove every spool file. Idempotent. */
  dispose(): Promise<void>;
}

/** A body that is not the multipart it claims, or is over a bound that ends the read. */
export class MultipartError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
    this.name = "MultipartError";
  }
}

export interface MultipartLimits {
  /** Where spool files go; created when absent. */
  spoolDir: string;
  /** Files written; any past it are counted only. */
  maxFiles: number;
  /** One file's bytes written; past it the rest is counted only. */
  maxFileSize: number;
  /** The whole body's bytes; past it the read ends with 413. */
  maxTotalSize: number;
  /** One text field's bytes. Default 1 MiB. */
  maxFieldBytes?: number;
  /** Only parts under these field names are files; another file part is read and dropped. Default: every file part. */
  fileFields?: ReadonlySet<string>;
}

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 16 * 1024;

/** The boundary a `multipart/form-data` Content-Type names, or null. */
export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data\b/i.test(contentType.trim())) return null;
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  return boundary && boundary.length <= 70 ? boundary : null;
}

/** The filename a `Content-Disposition` value names: RFC 5987 `filename*` first, then `filename`. */
function dispositionFilename(value: string): string | undefined {
  const star = /(?:^|;)\s*filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1] ?? "");
    } catch {
      return star[1];
    }
  }
  const plain = /(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"/i.exec(value);
  return plain ? (plain[1] ?? "").replace(/\\(.)/g, "$1") : undefined;
}

/** The name, filename and type a part's headers carry. */
function partHeaders(raw: string): { name: string; filename?: string; type: string } {
  const out: { name: string; filename?: string; type: string } = { name: "", type: "" };
  for (const line of raw.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "content-type") out.type = value;
    if (key !== "content-disposition") continue;
    out.name = /(?:^|;)\s*name="((?:[^"\\]|\\.)*)"/i.exec(value)?.[1] ?? "";
    const filename = dispositionFilename(value);
    if (filename !== undefined) out.filename = filename;
  }
  return out;
}

/** The part being read. */
interface Part {
  name: string;
  file?: SpooledFile;
  handle?: FileHandle;
  field?: Buffer[];
  fieldBytes: number;
}

type State = "preamble" | "after" | "headers" | "body" | "done";

const malformed = () => new MultipartError(400, "Invalid multipart form data");

/** The parser over one body: what it has read, and the part it is in. */
function createParser(boundary: string, limits: MultipartLimits) {
  const fields = new Map<string, string>();
  const files: SpooledFile[] = [];
  const paths: string[] = [];
  const maxField = limits.maxFieldBytes ?? 1_048_576;
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let written = 0;
  let part: Part | null = null;
  // Before the first part: the opening delimiter, which has no leading CRLF,
  // so the buffer starts with one.
  let buf: Buffer = Buffer.from(CRLF);
  let state: State = "preamble";

  async function openSpool(file: SpooledFile): Promise<FileHandle> {
    mkdirSync(limits.spoolDir, { recursive: true });
    const path = join(limits.spoolDir, `${randomBytes(16).toString("hex")}.part`);
    paths.push(path);
    file.path = path;
    return open(path, "wx", 0o600);
  }

  async function openPart(raw: string): Promise<void> {
    const h = partHeaders(raw);
    if (h.filename === undefined) {
      part = { name: h.name, field: [], fieldBytes: 0 };
      return;
    }
    if (limits.fileFields && !limits.fileFields.has(h.name)) {
      part = { name: h.name, fieldBytes: 0 };
      return;
    }
    const file: SpooledFile = { field: h.name, filename: h.filename, mimeType: h.type, size: 0 };
    files.push(file);
    part = { name: h.name, file, fieldBytes: 0 };
    if (written < limits.maxFiles) {
      written++;
      part.handle = await openSpool(file);
    }
  }

  async function writeFile(p: Part, bytes: Buffer): Promise<void> {
    if (!p.file) return;
    p.file.size += bytes.length;
    if (!p.handle) return;
    if (p.file.size > limits.maxFileSize) {
      // Past the per-file limit: stop writing; the intake refuses it by size.
      await p.handle.close();
      p.handle = undefined;
      return;
    }
    await p.handle.write(bytes);
  }

  async function writePart(bytes: Buffer): Promise<void> {
    const p = part;
    if (!p || bytes.length === 0) return;
    if (!p.field) return writeFile(p, bytes);
    p.fieldBytes += bytes.length;
    if (p.fieldBytes > maxField) throw new MultipartError(413, `Field "${p.name}" is too large`);
    p.field.push(bytes);
  }

  async function closePart(): Promise<void> {
    const p = part;
    part = null;
    if (!p) return;
    if (p.field) fields.set(p.name, Buffer.concat(p.field).toString("utf-8"));
    if (p.handle) await p.handle.close();
  }

  /** Before a delimiter: skip to it. */
  function preambleStep(): boolean {
    const at = buf.indexOf(delimiter);
    if (at < 0) {
      if (buf.length > MAX_HEADER_BYTES) throw malformed();
      return false;
    }
    buf = buf.subarray(at + delimiter.length);
    state = "after";
    return true;
  }

  /** After a delimiter: `--` ends the body, CRLF opens the next part. */
  function afterStep(): boolean {
    if (buf.length < 2) return false;
    if (buf[0] === 0x2d && buf[1] === 0x2d) {
      state = "done";
      return false;
    }
    if (buf[0] !== 0x0d || buf[1] !== 0x0a) throw malformed();
    buf = buf.subarray(2);
    state = "headers";
    return true;
  }

  /** A part's headers, up to the blank line. */
  async function headersStep(): Promise<boolean> {
    const end = buf.indexOf(HEADER_END);
    if (end < 0) {
      if (buf.length > MAX_HEADER_BYTES) throw malformed();
      return false;
    }
    await openPart(buf.subarray(0, end).toString("utf-8"));
    buf = buf.subarray(end + HEADER_END.length);
    state = "body";
    return true;
  }

  /** One step of the state machine over the buffer; false when it needs more bytes. */
  async function step(): Promise<boolean> {
    if (state === "preamble") return preambleStep();
    if (state === "after") return afterStep();
    if (state === "headers") return headersStep();
    if (state === "body") return bodyStep();
    return false;
  }

  /** In a part's body: write up to the next delimiter, keeping what could begin one. */
  async function bodyStep(): Promise<boolean> {
    const at = buf.indexOf(delimiter);
    if (at >= 0) {
      await writePart(Buffer.from(buf.subarray(0, at)));
      await closePart();
      buf = buf.subarray(at + delimiter.length);
      state = "after";
      return true;
    }
    const keep = Math.min(buf.length, delimiter.length - 1);
    await writePart(Buffer.from(buf.subarray(0, buf.length - keep)));
    buf = Buffer.from(buf.subarray(buf.length - keep));
    return false;
  }

  return {
    fields,
    files,
    paths,
    done: () => state === "done",
    async feed(chunk: Uint8Array): Promise<void> {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      while (await step()) {
        // Each step consumes what it can; the loop ends when one needs more bytes.
      }
    },
    async abort(): Promise<void> {
      const open = part as Part | null;
      if (open?.handle) await open.handle.close().catch(() => {});
    },
  };
}

/**
 * Read `body` as `multipart/form-data` with `boundary`, spooling file parts.
 * Throws {@link MultipartError} for a malformed body or one past a bound that
 * ends the read; the spool files are removed before it throws.
 */
export async function parseMultipart(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  limits: MultipartLimits,
): Promise<ParsedMultipart> {
  const parser = createParser(boundary, limits);
  const dispose = async () => {
    await Promise.all(parser.paths.splice(0).map((p) => rm(p, { force: true }).catch(() => {})));
  };
  try {
    if (!body) throw malformed();
    const reader = body.getReader();
    let total = 0;
    while (!parser.done()) {
      const { done, value } = await reader.read();
      if (done) throw malformed();
      total += value.byteLength;
      if (total > limits.maxTotalSize) {
        void reader.cancel().catch(() => {});
        throw new MultipartError(413, "Upload is over the size limit");
      }
      await parser.feed(value);
    }
    void reader.cancel().catch(() => {});
    return { fields: parser.fields, files: parser.files, dispose };
  } catch (err) {
    await parser.abort();
    await dispose();
    if (err instanceof MultipartError) throw err;
    throw malformed();
  }
}
