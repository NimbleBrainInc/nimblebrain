/**
 * The host context: who is calling (the principal) and the scope a call is walled to, as
 * a NimbleBrain host stamps it on every request it sends to a plugin server, at
 * `params._meta["ai.nimblebrain/context"]`. The rules are `contracts/host-context/CONTEXT.md`;
 * the shape is `schemas/host-context/v1/host-context.schema.json`, and this reader accepts
 * exactly what that schema accepts.
 *
 * Reading is not trusting: a server reads the context only from an authenticated host
 * transport (stdio, or HTTP with the host's credential).
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
 * The context a call is served under: the host context it carries, or `{}` when it carries
 * none. Every field may be absent: a call with no context names no principal and has no scope.
 */
export type CallContext = Partial<HostContext>;

/** The request metadata key the host context travels under. */
export const HOST_CONTEXT_META_KEY = "ai.nimblebrain/context";

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

/** Whether the call is the host's own. A call that names no principal is not. */
export function isHost(ctx: CallContext): boolean {
  return ctx.principal === "host";
}
