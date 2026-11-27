/**
 * Transfer URLs (CONTRACT.md §7): the bearer capabilities bytes move by. An upload URL
 * accepts only a PUT of its upload's body; a download URL answers only a GET of its file's
 * body, honouring a single `Range`.
 *
 * A URL is `<origin>/t/<id>.<secret>`: `id` (128 random bits) finds the grant, and `secret`
 * (256 random bits) is compared with the stored one in constant time, so the lookup leaks
 * nothing about the secret. Grants live in this process only: a restart kills every URL,
 * which the contract allows (an open upload then expires; a host resolves again). Every
 * request that is not a live grant's one operation, whatever it names, is answered alike:
 * 404, empty, no CORS headers. Nothing here logs a request, so a token never reaches a log.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import type { Store } from "./store.ts";

export const TRANSFER_PREFIX = "/t/";

interface Grant {
  secret: Buffer;
  kind: "upload" | "download";
  workspaceId: string;
  /** The upload's id, or the file's. */
  target: string;
  ownerId: string;
  expiresAt: number;
}

const NOT_FOUND = () => new Response(null, { status: 404 });

/** A single `bytes=` range, resolved against `size`: the bounds, `"unsatisfiable"`, or null. */
export function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const n = Number(b);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null;
  return { start, end };
}

export interface TransferOptions {
  store: Store;
  now: () => number;
  /** The origin URLs are issued on (`http://127.0.0.1:<port>`), known once listening. */
  origin: () => string;
}

export class Transfers {
  readonly #grants = new Map<string, Grant>();
  readonly #opts: TransferOptions;

  constructor(opts: TransferOptions) {
    this.#opts = opts;
  }

  #issue(grant: Omit<Grant, "secret">): string {
    const id = randomBytes(16).toString("hex");
    const secret = randomBytes(32);
    this.#grants.set(id, { ...grant, secret });
    return `${this.#opts.origin()}${TRANSFER_PREFIX}${id}.${secret.toString("base64url")}`;
  }

  issueUpload(workspaceId: string, ownerId: string, uploadId: string, expiresAt: number): string {
    return this.#issue({ kind: "upload", workspaceId, ownerId, target: uploadId, expiresAt });
  }

  issueDownload(workspaceId: string, ownerId: string, fileId: string, expiresAt: number): string {
    return this.#issue({ kind: "download", workspaceId, ownerId, target: fileId, expiresAt });
  }

  /** Kill every URL of one upload: it completed. */
  revokeUpload(workspaceId: string, uploadId: string): void {
    for (const [id, g] of this.#grants) {
      if (g.kind === "upload" && g.workspaceId === workspaceId && g.target === uploadId) {
        this.#grants.delete(id);
      }
    }
  }

  /** Kill every URL of a workspace: it was purged. */
  revokeWorkspace(workspaceId: string): void {
    for (const [id, g] of this.#grants) if (g.workspaceId === workspaceId) this.#grants.delete(id);
  }

  /** Forget grants that have expired. */
  sweep(): void {
    const now = this.#opts.now();
    for (const [id, g] of this.#grants) if (g.expiresAt <= now) this.#grants.delete(id);
  }

  /** The live grant a path names, compared in constant time, or null. */
  #grantFor(pathname: string): Grant | null {
    if (!pathname.startsWith(TRANSFER_PREFIX)) return null;
    const token = pathname.slice(TRANSFER_PREFIX.length);
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const grant = this.#grants.get(token.slice(0, dot));
    if (!grant) return null;
    const given = Buffer.from(token.slice(dot + 1), "base64url");
    if (given.length !== grant.secret.length || !timingSafeEqual(given, grant.secret)) return null;
    return grant.expiresAt > this.#opts.now() ? grant : null;
  }

  /** Answer one request to the listener. */
  async handle(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      if (url.search !== "") return NOT_FOUND();
      const grant = this.#grantFor(url.pathname);
      if (!grant) return NOT_FOUND();
      if (req.method === "GET" && grant.kind === "download") return this.#download(grant, req);
      if (req.method === "PUT" && grant.kind === "upload") return await this.#upload(grant, req);
      return NOT_FOUND();
    } catch {
      return NOT_FOUND();
    }
  }

  #download(grant: Grant, req: Request): Response {
    const { store } = this.#opts;
    const row = store.view(grant.workspaceId, (s) =>
      Object.hasOwn(s.files, grant.target) ? s.files[grant.target] : undefined,
    );
    const path =
      row && row.ownerId === grant.ownerId ? store.bodyPath(grant.workspaceId, row.id) : null;
    if (!row || !path) return NOT_FOUND();
    const file = Bun.file(path);
    const size = file.size;
    const header = req.headers.get("range");
    const range = header ? parseRange(header, size) : null;
    const base = { "content-type": "application/octet-stream", "accept-ranges": "bytes" };
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    if (range) {
      const length = range.end - range.start + 1;
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          ...base,
          "content-length": String(length),
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
        },
      });
    }
    return new Response(file, {
      status: 200,
      headers: { ...base, "content-length": String(size) },
    });
  }

  /**
   * Stream the body to a temporary file, at most the declared size, fsync it, and rename it
   * over the upload's body: a body is stored whole or not at all, and the last one stored
   * wins.
   */
  async #upload(grant: Grant, req: Request): Promise<Response> {
    const { store } = this.#opts;
    const upload = store.view(grant.workspaceId, (s) =>
      Object.hasOwn(s.uploads, grant.target) ? s.uploads[grant.target] : undefined,
    );
    if (!upload || upload.completed || upload.ownerId !== grant.ownerId) return NOT_FOUND();
    const target = store.uploadTarget(grant.workspaceId, upload.id);
    const fd = openSync(target.tmp, "w");
    let written = 0;
    let closed = false;
    try {
      if (req.body) {
        for await (const chunk of req.body) {
          written += chunk.byteLength;
          if (written > upload.size) {
            closeSync(fd);
            closed = true;
            target.abandon();
            return new Response(null, { status: 413 });
          }
          writeSync(fd, chunk);
        }
      }
      fsyncSync(fd);
      closeSync(fd);
      closed = true;
      const still = store.view(grant.workspaceId, (s) => s.uploads[upload.id]);
      if (!still || still.completed) {
        target.abandon();
        return NOT_FOUND();
      }
      target.commit();
      return new Response(null, { status: 204 });
    } catch (err) {
      if (!closed) closeSync(fd);
      target.abandon();
      throw err;
    }
  }
}
