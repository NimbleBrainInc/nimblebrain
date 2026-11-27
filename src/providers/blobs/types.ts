/**
 * The blob store provider (ADR-0076, "Providers carry the infrastructure").
 *
 * A blob is a write-once body of bytes held under a (scope, key). The store
 * holds bodies too large to cross MCP: a file someone uploads, a file an agent
 * writes. It knows nothing about what a body is; what a body means (its name,
 * its type, who may see it) is a record somebody else keeps, and the store
 * only answers for the bytes. This file is the contract every implementation
 * is held to, and the blob store's conformance suite tests each rule stated
 * here.
 *
 * ## Consumers
 *
 * - **The kernel's upload intake** puts every uploaded body, whatever door it
 *   came through (a chat attachment, a REST or bridge upload), then records it
 *   with the files contract's private `record` (`contracts/files/CONTRACT.md`).
 * - **The kernel's byte serving** gets a body after the files contract's
 *   private `resolve` has said the caller may see it: the browser download
 *   route, `resources/read` of a `files://` URI at the MCP door and the app
 *   bridge, an image or a PDF rehydrated into a model's prompt, and a
 *   connector's host-resources read.
 * - **The kernel's release sweep** deletes the bodies the files contract's
 *   `released` lists, and **its workspace purge** deletes a workspace's scope.
 * - **The files plugin** puts the body of a file an agent creates and gets a
 *   body to extract its text. It is not a kernel caller and cannot import this
 *   file; how it reaches the store is below.
 *
 * ## The files plugin uses the same store, by configuration
 *
 * The operator configures one store and gives its location to both the kernel
 * (as this provider) and the files plugin (in the plugin's own server
 * configuration). The plugin opens it with an implementation of the same
 * provider in its own language, held to the same rules, so a body either side
 * puts the other gets, and no body travels between them over MCP or through
 * either process. Locally that is one directory both processes use; at scale
 * it is one bucket both services reach.
 *
 * - **One owner per body.** The party that holds a body's bytes puts it, once:
 *   the kernel for an upload, the plugin for a file an agent creates. The
 *   kernel alone deletes, and only a body the plugin's records no longer
 *   reference (`released`) or a whole workspace being purged. The plugin calls
 *   `put` and `get`, never `delete` or `deleteScope`, so a deployment can
 *   grant it no more (at scale, a role with put and get on the bucket and no
 *   delete).
 * - **Each implementation states its layout on its medium** (how a scope and a
 *   key name a file in a directory, or an object in a bucket), so an
 *   implementation of the same provider in another language, given the same
 *   location, reads and writes the same bodies under the same rules.
 * - **Every implementation is safe for the kernel's process and the plugin's
 *   process at once**, wherever the deployment runs them that the
 *   implementation supports. `multiProcess` says only whether several runtime
 *   processes may share it.
 *
 * ## Scope and key
 *
 * A **scope** is the tenancy a body belongs to: for a file's body, the kernel
 * passes the workspace id, and never a value taken from tool input. A **key**
 * names one body within its scope. Both match `BLOB_NAME_PATTERN`: 1 to 128
 * characters of lowercase letters, digits, `_` and `-`, starting with a letter
 * or digit. The alphabet holds no `/`, `.` or uppercase, so a name is the same
 * on a case-insensitive filesystem, never traverses a path, and is one segment
 * of a bucket's object key. The store treats both as opaque, and keys under
 * different scopes never collide.
 *
 * **A key is minted by the party that puts it**, with at least 96 bits of
 * randomness, and is never reused: not after a failed put, and not after its
 * body is deleted. The store refuses a put only while the key holds a body, so
 * a reused key would name two bodies over time; minting fresh keys is the
 * caller's rule.
 *
 * ## Write-once, and partial is never visible
 *
 * A key holds at most one body, and that body never changes. A `get` sees a
 * body only once its `put` has succeeded, and then sees every byte of it. A put
 * that fails for any reason (past `maxBytes`, a body stream that errors, the
 * process dying mid-write) leaves the key holding nothing, and no `get` ever
 * returned a byte of it.
 *
 * ## Deliberately absent
 *
 * - **head** (size or existence without the bytes): no consumer needs it. The
 *   files plugin's record holds a body's size, and `get` answers the size with
 *   the bytes.
 * - **list**: what bodies exist is the record keeper's to say, never the
 *   store's to enumerate. The kernel learns which bodies to delete from
 *   `released`, and listing a bucket is slow, paid and eventually consistent.
 * - **Content addressing** (a key derived from the bytes, so equal bodies are
 *   stored once): two records sharing one body would give it two owners, and a
 *   delete would need a reference count. One random key per put keeps one
 *   owner per body.
 * - **Content type, filename, or any metadata**: the record is the one place
 *   they are true. A copy in the store would drift from it.
 * - **Presigned URLs**: a URL that reaches the bytes without the host would
 *   skip `resolve` on every request and the headers the host serves bytes
 *   under, and a filesystem has none to give. Every read goes through the
 *   host.
 */

/** The grammar of a scope and a key (see "Scope and key"). */
export const BLOB_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** A byte range of one body: `length` bytes from `offset`, or to the end when `length` is absent. */
export interface BlobRange {
  /** The first byte, counted from 0. A non-negative integer below the body's size. */
  offset: number;
  /** How many bytes, at least 1. Absent: to the end. A range past the end stops at the end. */
  length?: number;
}

export interface PutOptions {
  /**
   * The most bytes the body may hold: a positive integer. The caller sets it
   * from its own limit (the per-file upload limit, the largest file an agent
   * may create), so the store never holds more than a caller allowed.
   */
  maxBytes: number;
}

export interface PutResult {
  /** How many bytes the stored body holds. */
  size: number;
}

/** A body, or the range of it that was asked for. */
export interface BlobRead {
  /**
   * The bytes, as a stream the caller reads to its end or cancels. Cancelling
   * releases what the read holds.
   */
  body: ReadableStream<Uint8Array>;
  /** The size of the whole body, in bytes, whatever range was asked for. */
  size: number;
  /**
   * The range `body` holds, as the store clamped it to the body: absent when
   * the whole body was asked for.
   */
  range?: { offset: number; length: number };
}

/** The codes `BlobError` carries. */
export type BlobErrorCode =
  | "invalid_argument"
  | "blob_exists"
  | "blob_too_large"
  | "blob_not_found"
  | "range_not_satisfiable"
  | "closed";

/** Every refusal the store makes. A caller decides on `code`, never on the message. */
export class BlobError extends Error {
  constructor(
    readonly code: BlobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BlobError";
  }
}

/** A scope or key outside the grammar, a `maxBytes` or a range that is not well formed. Nothing changed. */
export class BlobArgumentError extends BlobError {
  constructor(message: string) {
    super("invalid_argument", message);
    this.name = "BlobArgumentError";
  }
}

/** `put` named a key that already holds a body. The body was not read; the stored one is unchanged. */
export class BlobExistsError extends BlobError {
  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super("blob_exists", `A body is already stored at ${scope}/${key}.`);
    this.name = "BlobExistsError";
  }
}

/** `put`'s body passed `maxBytes`. The put was abandoned and the key holds nothing. */
export class BlobTooLargeError extends BlobError {
  constructor(readonly maxBytes: number) {
    super("blob_too_large", `The body passed its limit of ${maxBytes} bytes.`);
    this.name = "BlobTooLargeError";
  }
}

/** No body under that scope and key: never put, deleted, or a put that did not finish. */
export class BlobNotFoundError extends BlobError {
  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super("blob_not_found", `No body is stored at ${scope}/${key}.`);
    this.name = "BlobNotFoundError";
  }
}

/** `get` asked for a range that starts at or past the end of the body. */
export class BlobRangeError extends BlobError {
  constructor(readonly size: number) {
    super("range_not_satisfiable", `The range starts past the end of a ${size}-byte body.`);
    this.name = "BlobRangeError";
  }
}

/** A method was called after `close`. */
export class BlobStoreClosedError extends BlobError {
  constructor() {
    super("closed", "The blob store is closed.");
    this.name = "BlobStoreClosedError";
  }
}

export interface BlobStore {
  /**
   * Store `body` under (`scope`, `key`), once. Resolves with the stored size
   * when every byte is durable and visible to `get`.
   *
   * Consumers: the kernel's upload intake (each uploaded body, under the
   * workspace's scope, with the per-file upload limit), and the files plugin
   * (the body of a file an agent creates).
   *
   * - **Write-once.** When the key already holds a body, rejects
   *   `BlobExistsError`, cancels `body` without reading it, and leaves the
   *   stored body unchanged. Of concurrent puts to one key, exactly one
   *   succeeds and every other rejects `BlobExistsError`.
   * - **Bounded.** Reads `body` until it ends, and rejects `BlobTooLargeError`
   *   as soon as the bytes read pass `maxBytes`, cancelling `body`. Never reads
   *   or holds the body whole in memory to decide.
   * - **Partial is never visible.** When the put rejects, whatever the cause (a
   *   limit, a stream that errors, which rejects with that stream's error), the
   *   key holds nothing, and no `get` returned a byte of it. A `get` while the
   *   put is in progress rejects `BlobNotFoundError`.
   * - Rejects `BlobArgumentError` for a scope or key outside the grammar, or a
   *   `maxBytes` that is not a positive integer, before reading `body`.
   *
   * An empty body is a body: it is stored, and `get` answers it with size 0.
   */
  put(
    scope: string,
    key: string,
    body: ReadableStream<Uint8Array>,
    options: PutOptions,
  ): Promise<PutResult>;

  /**
   * Read a body, whole or one range of it.
   *
   * Consumers: the kernel's byte serving (the download route, answering a
   * `Range` request with `range`; `resources/read` of a `files://` URI;
   * rehydrating an image or a PDF into a prompt; a connector's host-resources
   * read, ranged once that capability is), each after `resolve` answered the
   * key in the caller's scope; and the files plugin (a body whose text it
   * extracts).
   *
   * - Rejects `BlobNotFoundError` when the key holds no body.
   * - With `range`, `body` holds the bytes from `offset`, `length` of them or
   *   fewer at the end, and the answer's `range` says which. A range whose
   *   `offset` is at or past the body's size rejects `BlobRangeError` with the
   *   size, so a caller can answer `416` with it.
   * - Rejects `BlobArgumentError` for a scope or key outside the grammar, or a
   *   range whose `offset` is not a non-negative integer or whose `length` is
   *   not a positive integer.
   * - A body deleted while a read of it is streaming MAY finish streaming or
   *   end the stream with an error; it never yields bytes of another body.
   */
  get(scope: string, key: string, range?: BlobRange): Promise<BlobRead>;

  /**
   * Delete one body. Idempotent: a key that holds nothing resolves and
   * changes nothing. Once it resolves, `get` of the key rejects
   * `BlobNotFoundError`.
   *
   * Consumer: the kernel's release sweep, for each key the files contract's
   * `released` lists, and its intake, for a body whose `record` failed. Never
   * the files plugin.
   *
   * Rejects `BlobArgumentError` for a scope or key outside the grammar.
   */
  delete(scope: string, key: string): Promise<void>;

  /**
   * Delete every body under `scope`. Idempotent. Once it resolves, `get` of
   * any key that held a body in the scope when it was called rejects
   * `BlobNotFoundError`. A body put after it was called MAY survive it: the
   * caller ensures nothing is writing to the scope (a purged workspace takes
   * no uploads).
   *
   * Consumer: the kernel's workspace purge, after the files contract's
   * `delete_workspace`. Never the files plugin.
   *
   * Rejects `BlobArgumentError` for a scope outside the grammar.
   */
  deleteScope(scope: string): Promise<void>;

  /**
   * Release what the store holds (a connection, a handle). Idempotent. Every
   * other method rejects `BlobStoreClosedError` once it has been called;
   * reads already streaming MAY finish. Bodies are durable: a store opened
   * again on the same location gets every body it held.
   *
   * Consumer: the runtime's shutdown, after the sources that use the store
   * have stopped.
   */
  close(): Promise<void>;

  /**
   * Whether more than one runtime process may use this store's location at
   * once. A store that says false serves one runtime process (beside the files
   * plugin's, which every store admits), so a deployment of several runtime
   * processes needs one that says true (ADR-0076).
   */
  readonly multiProcess: boolean;
}
