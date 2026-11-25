/**
 * The authenticated context of one call: who is calling (the principal) and the scope the
 * call is walled to. A host mints it from the request it serves; a tool's arguments never
 * set it. How it travels is transport detail, read here in one place:
 *
 * - **Request metadata**: `params._meta["ai.nimblebrain/scope"]` =
 *   `{ workspaceId, ownerId, conversationId?, principal }`. A process the host started and
 *   alone holds (stdio) carries it this way.
 * - **Headers**: `x-nb-workspace-id`, `x-nb-owner-id`, `x-nb-conversation-id`,
 *   `x-nb-principal`, on a transport behind the host's credential.
 *
 * This module only reads. Whether a transport may be believed is the server's decision:
 * a server reads headers only from a request that presented the host's credential.
 */

/** Who is calling: the host itself, or a person directly or through an agent. */
export type Principal = "host" | "person";

/** The context one call carries. Absent fields were not stated. */
export interface CallContext {
  workspaceId?: string;
  ownerId?: string;
  /** The conversation the call is made inside, when it is made inside a chat. */
  conversationId?: string;
  /** Absent when the call names none; a call that names no principal is not `host`. */
  principal?: Principal;
}

/** The request metadata key the context travels under. */
export const SCOPE_META_KEY = "ai.nimblebrain/scope";

/** The headers the context travels in, by field. */
export const SCOPE_HEADERS = {
  workspaceId: "x-nb-workspace-id",
  ownerId: "x-nb-owner-id",
  conversationId: "x-nb-conversation-id",
  principal: "x-nb-principal",
} as const satisfies Record<keyof CallContext, string>;

function principalOf(value: unknown): Principal | undefined {
  return value === "host" || value === "person" ? value : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function compact(ctx: CallContext): CallContext {
  const out: CallContext = {};
  if (ctx.workspaceId) out.workspaceId = ctx.workspaceId;
  if (ctx.ownerId) out.ownerId = ctx.ownerId;
  if (ctx.conversationId) out.conversationId = ctx.conversationId;
  if (ctx.principal) out.principal = ctx.principal;
  return out;
}

/** The context in a request's `params._meta`, or undefined when the request states none. */
export function contextFromMeta(meta: unknown): CallContext | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const raw = (meta as Record<string, unknown>)[SCOPE_META_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return compact({
    workspaceId: textOf(r.workspaceId),
    ownerId: textOf(r.ownerId),
    conversationId: textOf(r.conversationId),
    principal: principalOf(r.principal),
  });
}

/** The context in a request's headers, or undefined when they state none. */
export function contextFromHeaders(headers: Headers): CallContext | undefined {
  const ctx = compact({
    workspaceId: textOf(headers.get(SCOPE_HEADERS.workspaceId)),
    ownerId: textOf(headers.get(SCOPE_HEADERS.ownerId)),
    conversationId: textOf(headers.get(SCOPE_HEADERS.conversationId)),
    principal: principalOf(headers.get(SCOPE_HEADERS.principal)),
  });
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/**
 * One call's context from what its transport carries: the request metadata when it states
 * one, else the headers when given, else none. A server passes `headers` only for a request
 * that presented the host's credential.
 */
export function callContext(source: { meta?: unknown; headers?: Headers }): CallContext {
  return (
    contextFromMeta(source.meta) ?? (source.headers ? contextFromHeaders(source.headers) : {}) ?? {}
  );
}

/** Whether the call is the host's own. A call that names no principal is not. */
export function isHost(ctx: CallContext): boolean {
  return ctx.principal === "host";
}
