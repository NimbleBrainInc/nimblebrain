/**
 * Kernel output-store seam — ONE interface, pluggable backends.
 *
 * An "output" is a durable, user-resolvable result the runtime produces on a
 * user's behalf: a synthesized research report, a generated document, an export.
 * The runtime is the only tenant-bound principal across every backend (it holds
 * the tenant-key mint or the workspace fs handle); bundles never touch the store
 * directly.
 *
 * There is exactly ONE blob stack here. The `dataplane` backend delegates to the
 * platform artifacts service (S3 + RLS, on our k8s platform); the `local` backend
 * persists to the kernel files store (a workspace PVC, the zero-infra/self-host
 * default); the `null` backend rejects every call with a clear typed error.
 *
 * Refs are the kernel `files://` scheme (`src/files/uri.ts`) — the same scheme
 * `read_resource` already resolves. We deliberately DO NOT mint an `artifact://`
 * scheme: a second resolvable URI shape would shadow the files primitive and is
 * the parallel-storage defect this seam exists to retire. The dataplane backend's
 * server-side `artifact://` URI is an internal detail the backend translates; it
 * never surfaces past this interface.
 */

import {
  type ArtifactMetadata,
  ArtifactsClient,
  type DataPlaneClientOptions,
} from "../dataplane/dataplane-client.ts";
import type { FileStore } from "./store.ts";
import type { FileEntry } from "./types.ts";
import { fileIdToUri, uriToFileId } from "./uri.ts";

/**
 * Identity dimension for an output operation. `workspace` is the tenant-key
 * mint / RLS dimension for the `dataplane` backend and the provenance breadcrumb
 * for `local`. A backend may key its storage on it, but the kernel files store
 * is identity-owned, so `local` records it rather than siloing by it.
 */
export interface OutputScope {
  workspace: string;
}

/** What a caller hands to `put`. */
export interface PutInput {
  /** Coarse kind, e.g. `report`, `document`. Stored as metadata, not interpreted. */
  type: string;
  mime: string;
  /** Raw body. Strings are UTF-8; bytes pass through verbatim. */
  body: string | Uint8Array;
  title?: string;
  citations?: Array<{ title?: string; url?: string }>;
  /** Optional time-to-live in seconds (dataplane honors it; local ignores it). */
  ttl?: number;
}

/** A resolvable reference to a stored output. `uri` is always `files://<id>`. */
export interface Ref {
  id: string;
  uri: string;
  mime: string;
  sizeBytes: number;
}

/** Metadata about a stored output (no body). */
export interface OutputMeta {
  id: string;
  uri: string;
  type: string;
  mime: string;
  title?: string;
  citations?: Array<{ title?: string; url?: string }>;
  sizeBytes: number;
  createdAt?: string;
}

/** A stored output plus its FULL body — never truncated. */
export interface OutputContent {
  meta: OutputMeta;
  body: Uint8Array;
}

/** Filters for `list`. */
export interface ListQuery {
  type?: string;
  limit?: number;
  cursor?: string;
}

/**
 * The one output-store interface. `get` returns the full body with NO size cap
 * (distinct from `read_resource`'s 12K peek); a failure to produce real content
 * must surface as a rejection, never a silent empty/truncated body.
 */
export interface OutputStore {
  put(scope: OutputScope, input: PutInput): Promise<Ref>;
  get(scope: OutputScope, id: string): Promise<OutputContent>;
  list(scope: OutputScope, query?: ListQuery): Promise<OutputMeta[]>;
}

/** Raised by every method of the `null` backend. Typed so callers can detect a
 *  deliberately-disabled store and surface an honest "unavailable" — never a
 *  fabricated substitute. */
export class OutputStoreDisabledError extends Error {
  readonly code = "output_store_disabled" as const;
  constructor(op: string) {
    super(`output store is disabled: cannot ${op}`);
    this.name = "OutputStoreDisabledError";
  }
}

const TEXT_DECODER = new TextDecoder();

function toBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

// ---------------------------------------------------------------------------
// dataplane backend
// ---------------------------------------------------------------------------

/**
 * How the dataplane backend reaches the artifacts service. Construction supplies
 * the base URL plus the tenant-key mint inputs (issuer, mint cache, base fetch);
 * the per-call `scope.workspace` becomes the token's workspace dimension, so the
 * backend builds a fresh `ArtifactsClient` per workspace.
 */
export interface DataplaneOutputStoreOptions {
  baseUrl: string;
  /** Authorizer issuer the tenant-key tokens mint against. */
  issuer: string;
  /** Shared mint cache; defaults to the process-wide singleton in the client. */
  cache?: DataPlaneClientOptions["cache"];
  /** Injectable base fetch for tests. */
  baseFetch?: typeof fetch;
  /** Idempotency-key generator for writes; defaults to a random key per put. */
  idempotencyKey?: (scope: OutputScope, input: PutInput) => string;
}

function metaFromArtifact(m: ArtifactMetadata): OutputMeta {
  return {
    // Refs are kernel `files://` — never the server's `artifact://` uri.
    id: m.artifactId,
    uri: fileIdToUri(m.artifactId),
    type: m.type,
    mime: m.mimeType,
    title: m.title ?? undefined,
    citations: m.citations ?? undefined,
    sizeBytes: m.sizeBytes,
    createdAt: m.createdAt ?? undefined,
  };
}

export function createDataplaneOutputStore(opts: DataplaneOutputStoreOptions): OutputStore {
  const clientFor = (scope: OutputScope) =>
    new ArtifactsClient(opts.baseUrl, {
      issuer: opts.issuer,
      workspace: scope.workspace,
      cache: opts.cache,
      baseFetch: opts.baseFetch,
    });
  const newIdem = opts.idempotencyKey ?? (() => crypto.randomUUID());

  return {
    async put(scope, input) {
      const ref = await clientFor(scope).writeArtifact({
        type: input.type,
        mimeType: input.mime,
        body: input.body,
        title: input.title,
        citations: input.citations,
        idempotencyKey: newIdem(scope, input),
        ttlSeconds: input.ttl,
      });
      return {
        id: ref.artifactId,
        uri: fileIdToUri(ref.artifactId),
        mime: ref.mimeType,
        sizeBytes: ref.sizeBytes,
      };
    },

    async get(scope, id) {
      const client = clientFor(scope);
      // Read scope mints `artifacts:read` (distinct from the write token) for
      // both the metadata and the content fetch.
      const [meta, content] = await Promise.all([
        client.getArtifact(id),
        client.getArtifactContent(id),
      ]);
      return { meta: metaFromArtifact(meta), body: content.body };
    },

    async list(scope, query) {
      const page = await clientFor(scope).listArtifacts({
        type: query?.type,
        limit: query?.limit,
        cursor: query?.cursor,
      });
      return page.artifacts.map(metaFromArtifact);
    },
  };
}

// ---------------------------------------------------------------------------
// local backend
// ---------------------------------------------------------------------------

/**
 * The `local` backend persists to the kernel files store and round-trips via
 * `files://`. It is the zero-infra / self-host default: no data plane, no mint,
 * no network — just the workspace PVC.
 *
 * `resolveStore` lets the caller pick the FileStore for a scope (the runtime
 * resolves an identity-owned store); a single-store form is fine for tests and
 * single-tenant self-hosters.
 */
export interface LocalOutputStoreOptions {
  resolveStore: (scope: OutputScope) => FileStore;
}

function metaFromEntry(entry: FileEntry): OutputMeta {
  // `type`/`title`/`citations` ride in the registry `description` as a JSON
  // sidecar so `list`/`get` recover them without a second store.
  let extra: { type?: string; title?: string; citations?: OutputMeta["citations"] } = {};
  if (entry.description) {
    try {
      extra = JSON.parse(entry.description) as typeof extra;
    } catch {
      // Legacy/foreign entry — fall back to filename as title.
    }
  }
  return {
    id: entry.id,
    uri: fileIdToUri(entry.id),
    type: extra.type ?? "output",
    mime: entry.mimeType,
    title: extra.title ?? entry.filename,
    citations: extra.citations,
    sizeBytes: entry.size,
    createdAt: entry.createdAt,
  };
}

export function createLocalOutputStore(opts: LocalOutputStoreOptions): OutputStore {
  return {
    async put(scope, input) {
      const store = opts.resolveStore(scope);
      const bytes = toBytes(input.body);
      const filename = `${input.title ?? input.type}`.slice(0, 200) || "output";
      const saved = await store.saveFile(Buffer.from(bytes), filename, input.mime);
      // Persist a registry entry so `get`/`list` can recover the bytes and the
      // output metadata (type/title/citations packed into `description`).
      await store.appendRegistry({
        id: saved.id,
        filename,
        mimeType: input.mime,
        size: saved.size,
        tags: ["output", input.type],
        source: "agent",
        conversationId: null,
        createdAt: new Date().toISOString(),
        description: JSON.stringify({
          type: input.type,
          title: input.title,
          citations: input.citations,
        }),
        workspaceId: scope.workspace,
      });
      return {
        id: saved.id,
        uri: fileIdToUri(saved.id),
        mime: input.mime,
        sizeBytes: saved.size,
      };
    },

    async get(scope, id) {
      const store = opts.resolveStore(scope);
      const entry = await store.findEntry(id);
      if (!entry) throw new Error(`output not found: ${id}`);
      const file = await store.readFile(id);
      // FULL body — no truncation.
      return { meta: metaFromEntry(entry), body: new Uint8Array(file.data) };
    },

    async list(scope, query) {
      const store = opts.resolveStore(scope);
      const entries = await store.readRegistry();
      // Only outputs this store produced (tagged at put), newest first.
      let metas = entries
        .filter((e) => e.tags.includes("output"))
        .map(metaFromEntry)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      if (query?.type) metas = metas.filter((m) => m.type === query.type);
      if (query?.limit !== undefined) metas = metas.slice(0, query.limit);
      return metas;
    },
  };
}

// ---------------------------------------------------------------------------
// null backend
// ---------------------------------------------------------------------------

/** A disabled store. Every method rejects with `OutputStoreDisabledError` so a
 *  caller gets an explicit failure, never a silent empty result. */
export function createNullOutputStore(): OutputStore {
  return {
    async put() {
      throw new OutputStoreDisabledError("put");
    },
    async get() {
      throw new OutputStoreDisabledError("get");
    },
    async list() {
      throw new OutputStoreDisabledError("list");
    },
  };
}

/** Decode an output body as UTF-8 text. Convenience for text outputs (reports). */
export function decodeOutputText(content: OutputContent): string {
  return TEXT_DECODER.decode(content.body);
}

/** Recover the id from a `files://` output ref, or null for any other scheme. */
export function outputRefToId(uri: string): string | null {
  return uriToFileId(uri);
}
