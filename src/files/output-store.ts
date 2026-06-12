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
 * mint / RLS dimension for the `dataplane` backend AND the storage-fencing key
 * for the `local` backend. ONE resource primitive, fenced by scope: a `put`
 * under workspace A must NOT be retrievable via `get`/`list` under workspace B
 * on any backend.
 */
export interface OutputScope {
  workspace: string;
}

/** What a caller hands to `put`. */
export interface PutInput {
  /**
   * Discriminator kind, e.g. `report`, `upload`, `export`. This is the field
   * that differentiates one resource from another — uploads and agent outputs
   * are ONE primitive, told apart by `kind` (see spec D1). Stored as metadata,
   * not interpreted by the store.
   */
  kind: string;
  /**
   * Provenance, e.g. `tool:deep_research`, `user:<id>`. Records WHO produced the
   * output. Stored as metadata; the dataplane backend maps it to the artifacts
   * `source` field.
   */
  producedBy?: string;
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
  /** The discriminator kind the output was stored with. */
  kind: string;
  /** The workspace the output was fenced to. */
  scope: OutputScope;
  /** Provenance, when the caller supplied it. */
  producedBy?: string;
}

/** Metadata about a stored output (no body). */
export interface OutputMeta {
  id: string;
  uri: string;
  /** Discriminator kind (`report`, `upload`, …) — query this to tell resources apart. */
  kind: string;
  mime: string;
  title?: string;
  citations?: Array<{ title?: string; url?: string }>;
  sizeBytes: number;
  createdAt?: string;
  /** Provenance (`tool:deep_research`, `user:<id>`), when recorded. */
  producedBy?: string;
  /**
   * The workspace the output was produced under. Both backends fence reads on
   * this: the `dataplane` backend at the RLS boundary (the read token is
   * workspace-dimensioned), and the `local` backend by siloing storage under
   * the workspace dir (and as an explicit check so a caller — e.g.
   * `nb__get_output` — never surfaces another workspace's output). May be absent
   * for legacy/foreign entries.
   */
  workspace?: string;
}

/** A stored output plus its FULL body — never truncated. */
export interface OutputContent {
  meta: OutputMeta;
  body: Uint8Array;
}

/** Filters for `list`. */
export interface ListQuery {
  /** Filter to one discriminator kind (`report`, `upload`, …). */
  kind?: string;
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
    // The artifacts service `type` field IS `kind` at the storage layer (D1).
    kind: m.type,
    mime: m.mimeType,
    title: m.title ?? undefined,
    citations: m.citations ?? undefined,
    sizeBytes: m.sizeBytes,
    createdAt: m.createdAt ?? undefined,
    // `producedBy` rides in the artifacts `source` column.
    producedBy: m.source ?? undefined,
    workspace: m.workspaceId,
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
        // `kind` IS the artifacts `type` at the storage layer (D1).
        type: input.kind,
        mimeType: input.mime,
        body: input.body,
        title: input.title,
        citations: input.citations,
        // `producedBy` maps to the artifacts `source` column.
        // TODO(platform): confirm the artifacts write API persists `source` on
        // POST (it's already returned on read/list metadata); if it doesn't, add
        // a `source`/`producedBy` column on the write path.
        source: input.producedBy,
        idempotencyKey: newIdem(scope, input),
        ttlSeconds: input.ttl,
      });
      return {
        id: ref.artifactId,
        uri: fileIdToUri(ref.artifactId),
        mime: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        kind: input.kind,
        scope,
        producedBy: input.producedBy,
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
        // `kind` filters on the artifacts `type` field.
        type: query?.kind,
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
 * The `local` backend persists to a WORKSPACE-SCOPED file store and round-trips
 * via `files://`. It is the zero-infra / self-host default: no data plane, no
 * mint, no network — just the workspace PVC.
 *
 * SCOPE FENCING (the 002b bug fix): `resolveStore(scope)` MUST return a store
 * rooted under `scope.workspace` (e.g. `workspaces/{wsId}/files`), NOT the
 * identity-owned user file store. Wiring it to `getFileStore(userId)` siloed
 * outputs by identity, so a workspace-A report surfaced in the user's global
 * files and across every workspace they touched. The runtime now resolves a
 * per-workspace store, so storage is fenced structurally. We ALSO record the
 * workspace on each entry and re-check it on `get`/`list` as defence in depth
 * (a shared store, e.g. in tests, still fences A from B).
 */
export interface LocalOutputStoreOptions {
  resolveStore: (scope: OutputScope) => FileStore;
}

function metaFromEntry(entry: FileEntry): OutputMeta {
  // `kind`/`producedBy`/`title`/`citations` ride in the registry `description`
  // as a JSON sidecar so `list`/`get` recover them without a second store.
  let extra: {
    kind?: string;
    producedBy?: string;
    title?: string;
    citations?: OutputMeta["citations"];
  } = {};
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
    kind: extra.kind ?? "output",
    mime: entry.mimeType,
    title: extra.title ?? entry.filename,
    citations: extra.citations,
    sizeBytes: entry.size,
    createdAt: entry.createdAt,
    producedBy: extra.producedBy,
    workspace: entry.workspaceId,
  };
}

export function createLocalOutputStore(opts: LocalOutputStoreOptions): OutputStore {
  return {
    async put(scope, input) {
      const store = opts.resolveStore(scope);
      const bytes = toBytes(input.body);
      const filename = `${input.title ?? input.kind}`.slice(0, 200) || "output";
      const saved = await store.saveFile(Buffer.from(bytes), filename, input.mime);
      // Persist a registry entry so `get`/`list` can recover the bytes and the
      // output metadata (kind/producedBy/title/citations packed into
      // `description`). `workspaceId` is the fencing key.
      await store.appendRegistry({
        id: saved.id,
        filename,
        mimeType: input.mime,
        size: saved.size,
        tags: ["output", input.kind],
        source: "agent",
        conversationId: null,
        createdAt: new Date().toISOString(),
        description: JSON.stringify({
          kind: input.kind,
          producedBy: input.producedBy,
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
        kind: input.kind,
        scope,
        producedBy: input.producedBy,
      };
    },

    async get(scope, id) {
      const store = opts.resolveStore(scope);
      const entry = await store.findEntry(id);
      // Fence: not in this scope's store, or recorded under a different
      // workspace → not found. A `get` scoped to B must never read A's output.
      if (!entry || (entry.workspaceId && entry.workspaceId !== scope.workspace)) {
        throw new Error(`output not found: ${id}`);
      }
      const file = await store.readFile(id);
      // FULL body — no truncation.
      return { meta: metaFromEntry(entry), body: new Uint8Array(file.data) };
    },

    async list(scope, query) {
      const store = opts.resolveStore(scope);
      const entries = await store.readRegistry();
      // Only outputs this store produced (tagged at put), fenced to this
      // workspace, newest first.
      let metas = entries
        .filter((e) => e.tags.includes("output"))
        .filter((e) => !e.workspaceId || e.workspaceId === scope.workspace)
        .map(metaFromEntry)
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      if (query?.kind) metas = metas.filter((m) => m.kind === query.kind);
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

// ---------------------------------------------------------------------------
// provider selection (task 005)
// ---------------------------------------------------------------------------

/**
 * Which output-store backend the runtime selected, and WHY. The kind drives
 * tool/source registration (the `dataplane`/`local` stores expose
 * `nb__get_output` + the resolvable source; `null` omits them); the `reason`
 * is logged once at startup so an operator can see the chosen backend without
 * inferring it from a constellation of env vars.
 */
export type OutputStoreKind = "dataplane" | "local" | "null";

export interface OutputStoreSelection {
  kind: OutputStoreKind;
  /** Human-readable one-liner for the startup log (which backend + why). */
  reason: string;
  /** The resolved store. Present for every kind — `null` resolves to the disabled store. */
  store: OutputStore;
}

/**
 * The config inputs the resolver reads. Env vars are read by the runtime and
 * passed in (not read here) so the resolver stays a pure function that tests
 * drive directly. The dataplane URL + issuer are the only signal that the data
 * plane is wired; `force` is the explicit override.
 */
export interface ResolveOutputStoreConfig {
  /**
   * Explicit override. `"none"` forces the `null` backend even when the data
   * plane is fully configured (kill-switch for a degraded data plane);
   * `"local"`/`"dataplane"` force that backend; `undefined` auto-selects.
   * From `NB_OUTPUT_STORE` — task 009 must match this name.
   */
  force?: string;
  /** Fleet authorizer issuer (`NB_FLEET_AUTHORIZER_ISSUER`). */
  issuer?: string;
  /** Artifacts service base URL (`NB_ARTIFACTS_URL`) — the data-plane signal. */
  dataplaneUrl?: string;
  /** Builds the dataplane store when the data plane is selected. */
  makeDataplane: (opts: { baseUrl: string; issuer: string }) => OutputStore;
  /** Builds the local store (binds the runtime's identity-owned FileStore). */
  makeLocal: () => OutputStore;
}

/**
 * Resolve the active output-store backend EXPLICITLY — by config, not by
 * per-capability env-presence. The rules, in order:
 *
 *   1. `force === "none"`        → `null`      (kill-switch; fail closed)
 *   2. `force === "local"`       → `local`     (forced self-host)
 *   3. `force === "dataplane"`   → `dataplane`  (only if issuer + URL present;
 *                                                else `null` — a forced data
 *                                                plane with no URL is a misconfig,
 *                                                not a silent fall-back to local)
 *   4. issuer + dataplaneUrl set → `dataplane`  (auto: the data plane is wired)
 *   5. otherwise                 → `local`      (zero-infra default; off-platform works)
 *
 * Default is `local`, so a fresh checkout with no env stores outputs to the
 * workspace PVC and every output path works with no data plane at all.
 */
export function resolveOutputStore(config: ResolveOutputStoreConfig): OutputStoreSelection {
  const force = config.force?.trim().toLowerCase();
  const { issuer, dataplaneUrl } = config;
  // Narrowed locals (not `config.x!`) so the dataplane branches type-check
  // without non-null assertions — `dataplane` is non-null only when both are set.
  const dataplane = issuer && dataplaneUrl ? { baseUrl: dataplaneUrl, issuer } : null;

  if (force === "none") {
    return {
      kind: "null",
      reason: "output store disabled by NB_OUTPUT_STORE=none",
      store: createNullOutputStore(),
    };
  }

  if (force === "local") {
    return {
      kind: "local",
      reason: "output store forced local by NB_OUTPUT_STORE=local",
      store: config.makeLocal(),
    };
  }

  if (force === "dataplane") {
    if (!dataplane) {
      return {
        kind: "null",
        reason:
          "output store forced dataplane by NB_OUTPUT_STORE=dataplane but issuer/URL are not set — disabling (fail closed)",
        store: createNullOutputStore(),
      };
    }
    return {
      kind: "dataplane",
      store: config.makeDataplane(dataplane),
      reason: "output store forced dataplane by NB_OUTPUT_STORE=dataplane",
    };
  }

  if (dataplane) {
    return {
      kind: "dataplane",
      store: config.makeDataplane(dataplane),
      reason: "output store using dataplane (fleet issuer + artifacts URL configured)",
    };
  }

  return {
    kind: "local",
    reason: "output store using local file store (no data plane configured — zero-infra default)",
    store: config.makeLocal(),
  };
}

// ---------------------------------------------------------------------------
// task-runner provider selection (task 005) — same selection shape
// ---------------------------------------------------------------------------

/**
 * The task-runner backend selection. Only `dataplane` (nimbletasks) and `null`
 * are implemented today — there is no local task runner — but the selection
 * shares ONE model with the output store so artifacts + tasks resolve the same
 * way: explicit force, then the data-plane signal, then fail closed. The kind
 * gates whether durable-task surfaces (deep_research) are wired.
 */
export type TaskRunnerKind = "dataplane" | "null";

export interface TaskRunnerSelection {
  kind: TaskRunnerKind;
  reason: string;
  /** nimbletasks base URL + issuer when `dataplane`; absent for `null`. */
  dataplane?: { baseUrl: string; issuer: string };
}

export interface ResolveTaskRunnerConfig {
  /** Explicit override (`NB_TASK_RUNNER`): `"none"` forces `null`. */
  force?: string;
  /** Fleet authorizer issuer (`NB_FLEET_AUTHORIZER_ISSUER`). */
  issuer?: string;
  /** nimbletasks service base URL (`NB_NIMBLETASKS_URL`) — the data-plane signal. */
  nimbletasksUrl?: string;
}

/**
 * Resolve the task-runner backend. Mirrors `resolveOutputStore`: `none` forces
 * disabled; issuer + URL present selects `dataplane`; otherwise `null` (there is
 * no zero-infra task runner, so the default off-platform state is "no durable
 * tasks", not "local tasks"). Failing closed here means deep_research is simply
 * absent off-platform rather than pretending to run.
 */
export function resolveTaskRunner(config: ResolveTaskRunnerConfig): TaskRunnerSelection {
  const force = config.force?.trim().toLowerCase();
  const { issuer, nimbletasksUrl } = config;
  const dataplane = issuer && nimbletasksUrl ? { baseUrl: nimbletasksUrl, issuer } : null;

  if (force === "none") {
    return { kind: "null", reason: "task runner disabled by NB_TASK_RUNNER=none" };
  }

  if (dataplane) {
    return {
      kind: "dataplane",
      dataplane,
      reason: "task runner using dataplane nimbletasks (fleet issuer + nimbletasks URL configured)",
    };
  }

  return {
    kind: "null",
    reason: "task runner disabled (no data plane configured — durable tasks unavailable)",
  };
}
