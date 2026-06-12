import {
  createMintingFetch,
  getDefaultServiceTokenCache,
  type ServiceTokenCache,
} from "../oauth/tenant-key-mint.ts";

/**
 * Runtime clients for the platform data-plane REST services — nimbletasks
 * (durable async tasks) and artifacts (the artifact store).
 *
 * These are the runtime's OWN calls into the data plane, authenticated with the
 * tenant-key mint: the runtime is the only tenant-bound principal (it holds the
 * per-tenant key), so it mints a short-lived, workspace-scoped token per service
 * and calls REST directly. No fleet bundle ever holds a data-plane credential —
 * a deliberate trust-boundary choice (see the mode-2 auth review): a bundle's
 * identity isn't tenant-bound, so letting it reach the data plane would let a
 * compromised bundle act across tenants. The runtime keeps that authority.
 *
 * Auth per service (all via `createMintingFetch`, which mints on demand, caches,
 * and re-mints on 401):
 *   - nimbletasks: `aud=mcp-fleet` (staging `callerAudience`), scope
 *     `nimbletasks:create`. nimbletasks fences rows by the token's
 *     (tenant_id, workspace_id) via RLS.
 *   - artifacts:   `aud=artifacts`, scope `artifacts:write`.
 *
 * The workspace dimension is the runtime's real workspace id, minted verbatim.
 */

/** Audience the data-plane services validate. nimbletasks accepts the shared
 *  fleet audience (its `callerAudience`); artifacts pins its own. */
const NIMBLETASKS_AUDIENCE = "mcp-fleet";
const NIMBLETASKS_SCOPE = "nimbletasks:create";
const ARTIFACTS_AUDIENCE = "artifacts";
const ARTIFACTS_WRITE_SCOPE = "artifacts:write";

export class DataPlaneError extends Error {
  readonly status: number;
  constructor(service: string, status: number, detail: string) {
    super(`${service} request failed ${status}: ${detail.slice(0, 300)}`);
    this.status = status;
    this.name = "DataPlaneError";
  }
}

async function readError(res: Response): Promise<string> {
  return res.text().catch(() => "");
}

export interface DataPlaneClientOptions {
  /** Authorizer issuer the tokens are minted against (NB_FLEET_AUTHORIZER_ISSUER). */
  issuer: string;
  /** The connection's workspace — the token/RLS dimension. */
  workspace: string;
  /** Shared mint cache; defaults to the process-wide singleton. */
  cache?: ServiceTokenCache;
  /** Injectable base fetch for tests. */
  baseFetch?: typeof fetch;
}

// ---------------------------------------------------------------------------
// nimbletasks
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  taskType: string;
  input?: Record<string, unknown>;
  idempotencyKey: string;
  /** Audit breadcrumbs. */
  mcpServer?: string;
  toolName?: string;
}

export interface TaskRef {
  taskId: string;
  status: string;
  statusMessage?: string | null;
}

export interface TaskResult {
  available: boolean;
  result: unknown;
}

/**
 * Create + poll durable tasks on nimbletasks. The runtime drives the task; the
 * worker (a nimbletasks Job) does the work and reports back. The runtime reads
 * the terminal result here and persists it (e.g. to artifacts).
 */
export class NimbleTasksClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    opts: DataPlaneClientOptions,
  ) {
    this.fetchImpl = createMintingFetch({
      cache: opts.cache ?? getDefaultServiceTokenCache(),
      issuer: opts.issuer,
      workspace: opts.workspace,
      audience: NIMBLETASKS_AUDIENCE,
      scope: NIMBLETASKS_SCOPE,
      baseFetch: opts.baseFetch,
    });
  }

  async createTask(req: CreateTaskInput): Promise<TaskRef> {
    const res = await this.fetchImpl(new URL("/v1/tasks", this.baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task_type: req.taskType,
        input: req.input ?? {},
        idempotency_key: req.idempotencyKey,
        mcp_server: req.mcpServer,
        tool_name: req.toolName,
      }),
    });
    if (!res.ok)
      throw new DataPlaneError("nimbletasks createTask", res.status, await readError(res));
    const json = (await res.json()) as {
      task_id: string;
      status: string;
      status_message?: string | null;
    };
    return { taskId: json.task_id, status: json.status, statusMessage: json.status_message };
  }

  async getTask(taskId: string): Promise<TaskRef> {
    const res = await this.fetchImpl(new URL(`/v1/tasks/${taskId}`, this.baseUrl).toString());
    if (!res.ok) throw new DataPlaneError("nimbletasks getTask", res.status, await readError(res));
    const json = (await res.json()) as {
      task_id: string;
      status: string;
      status_message?: string | null;
    };
    return { taskId: json.task_id, status: json.status, statusMessage: json.status_message };
  }

  async getResult(taskId: string): Promise<TaskResult> {
    const res = await this.fetchImpl(
      new URL(`/v1/tasks/${taskId}/result`, this.baseUrl).toString(),
    );
    if (!res.ok)
      throw new DataPlaneError("nimbletasks getResult", res.status, await readError(res));
    const json = (await res.json()) as { available: boolean; result: unknown };
    return { available: json.available, result: json.result };
  }
}

/** Terminal task statuses (MCP tasks SEP-1686 projection). */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export interface WriteArtifactInput {
  type: string;
  mimeType: string;
  /** Raw body; encoded to base64 for the wire. */
  body: string | Uint8Array;
  title?: string;
  citations?: Array<{ title?: string; url?: string }>;
  idempotencyKey: string;
  ttlSeconds?: number;
}

export interface ArtifactRef {
  artifactId: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
}

function toBase64(body: string | Uint8Array): string {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  return buf.toString("base64");
}

/** Write artifacts the user can later resolve. tenant_id/workspace_id come from
 *  the minted token (never the body); RLS fences the write. */
export class ArtifactsClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    opts: DataPlaneClientOptions,
  ) {
    this.fetchImpl = createMintingFetch({
      cache: opts.cache ?? getDefaultServiceTokenCache(),
      issuer: opts.issuer,
      workspace: opts.workspace,
      audience: ARTIFACTS_AUDIENCE,
      scope: ARTIFACTS_WRITE_SCOPE,
      baseFetch: opts.baseFetch,
    });
  }

  async writeArtifact(req: WriteArtifactInput): Promise<ArtifactRef> {
    const res = await this.fetchImpl(new URL("/v1/artifacts", this.baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: req.type,
        mime_type: req.mimeType,
        title: req.title,
        body_b64: toBase64(req.body),
        citations: req.citations,
        idempotency_key: req.idempotencyKey,
        ttl_seconds: req.ttlSeconds,
      }),
    });
    if (!res.ok)
      throw new DataPlaneError("artifacts writeArtifact", res.status, await readError(res));
    const json = (await res.json()) as {
      artifact_id: string;
      uri: string;
      mime_type: string;
      size_bytes: number;
    };
    return {
      artifactId: json.artifact_id,
      uri: json.uri,
      mimeType: json.mime_type,
      sizeBytes: json.size_bytes,
    };
  }
}
