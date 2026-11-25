/**
 * The host context: who is calling (the principal) and the scope a call is walled to, as
 * a NimbleBrain host stamps it on every request it sends to a plugin server, at
 * `params._meta["ai.nimblebrain/context"]`. The rules are `contracts/host-context/CONTEXT.md`;
 * the shape is `schemas/host-context/v1/host-context.schema.json`, and this reader accepts
 * exactly what that schema accepts.
 *
 * Reading is not trusting: a server reads the context only from an authenticated host
 * transport (stdio, or HTTP with the host's credential), and passes in any dimension its
 * transport verified itself.
 */

/** Who is calling: the host's own code, or a person directly or through an agent or app. */
export type Principal = "host" | "person";

/** The host context as the schema defines it. */
export interface HostContext {
  principal: Principal;
  workspaceId?: string;
  ownerId?: string;
  /** The conversation the call is made inside, during a chat turn. */
  conversationId?: string;
}

/**
 * The context a call is served under. Every field may be absent: a call with no context
 * names no principal and has no scope.
 */
export type CallContext = Partial<HostContext>;

/** The request metadata key the host context travels under. */
export const HOST_CONTEXT_META_KEY = "ai.nimblebrain/context";

/** The one error of the host-context spec: the host's word contradicts the transport's. */
export const CONTEXT_MISMATCH = "context_mismatch";

/** Dimensions a transport verified itself, such as an edge's `x-tenant-id` and `x-workspace-id`. */
export interface VerifiedDimensions {
  tenantId?: string;
  workspaceId?: string;
}

const OPTIONAL_FIELDS = ["workspaceId", "ownerId", "conversationId"] as const;

/**
 * The host context in a request's `params._meta`, or undefined when there is none or the
 * value fails the schema (a value that fails it is no context). Unknown fields are ignored.
 */
export function readHostContext(meta: unknown): HostContext | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const raw = (meta as Record<string, unknown>)[HOST_CONTEXT_META_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.principal !== "host" && r.principal !== "person") return undefined;
  const ctx: HostContext = { principal: r.principal };
  for (const field of OPTIONAL_FIELDS) {
    const value = r[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) return undefined;
    ctx[field] = value;
  }
  return ctx;
}

export type CallContextResult =
  | {
      ok: true;
      context: CallContext;
      /** The tenant the transport verified; a multi-tenant server walls every call by it. */
      tenantId?: string;
    }
  | { ok: false; code: typeof CONTEXT_MISMATCH; error: string };

/**
 * One call's context: the host context in its `_meta`, with the dimensions the transport
 * verified applied. A verified value wins and fills an absent one; a context that names a
 * different value is refused as `context_mismatch`, and the server answers it before any
 * tool runs.
 */
export function callContext(meta: unknown, verified: VerifiedDimensions = {}): CallContextResult {
  const context: CallContext = readHostContext(meta) ?? {};
  const workspaceId = verified.workspaceId;
  if (workspaceId !== undefined) {
    if (context.workspaceId !== undefined && context.workspaceId !== workspaceId) {
      return {
        ok: false,
        code: CONTEXT_MISMATCH,
        error: "the context's workspaceId is not the workspace the transport verified",
      };
    }
    context.workspaceId = workspaceId;
  }
  return {
    ok: true,
    context,
    ...(verified.tenantId !== undefined ? { tenantId: verified.tenantId } : {}),
  };
}

/** Whether the call is the host's own. A call that names no principal is not. */
export function isHost(ctx: CallContext): boolean {
  return ctx.principal === "host";
}
