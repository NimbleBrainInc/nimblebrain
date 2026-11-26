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
  /**
   * The run grant, on a person's call to a tool its contract marks `grant: true`. Opaque: a
   * server stores it and returns it verbatim, and never parses it.
   */
  grant?: string;
  /** True when the call is made inside an unattended run, with no person present. */
  unattended?: boolean;
}

/**
 * The context a call is served under: the host context it carries, or `{}` when it carries
 * none. Every field may be absent: a call with no context names no principal and has no scope.
 */
export type CallContext = Partial<HostContext>;

/** The request metadata key the host context travels under. */
export const HOST_CONTEXT_META_KEY = "ai.nimblebrain/context";

const OPTIONAL_STRINGS = ["workspaceId", "ownerId", "conversationId"] as const;

/** The longest grant the schema accepts. */
const MAX_GRANT_LENGTH = 4096;

/** A non-empty string no longer than `max`. */
function isText(value: unknown, max = Number.POSITIVE_INFINITY): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** The context's optional fields, or undefined when one fails the schema. */
function optionalFields(r: Record<string, unknown>): Omit<HostContext, "principal"> | undefined {
  const out: Omit<HostContext, "principal"> = {};
  for (const field of OPTIONAL_STRINGS) {
    const value = r[field];
    if (value === undefined) continue;
    if (!isText(value)) return undefined;
    out[field] = value;
  }
  if (r.grant !== undefined) {
    if (!isText(r.grant, MAX_GRANT_LENGTH)) return undefined;
    out.grant = r.grant;
  }
  if (r.unattended !== undefined) {
    if (typeof r.unattended !== "boolean") return undefined;
    out.unattended = r.unattended;
  }
  return out;
}

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
  const fields = optionalFields(r);
  return fields ? { principal: r.principal, ...fields } : undefined;
}

/** Whether the call is the host's own. A call that names no principal is not. */
export function isHost(ctx: CallContext): boolean {
  return ctx.principal === "host";
}
