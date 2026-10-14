/**
 * How to ask a connector which account it is signed in as.
 *
 * A connection's account comes from whoever knows it. An OIDC authorization
 * server says so at sign-in (the id_token, or userinfo) and a broker may record
 * it; both are captured when the connection lands. A service that is neither
 * has only its own API to ask, and that API is one of the connector's tools.
 * Which tool, and where in its answer the account is, is a fact about the
 * service, so the catalog entry states it:
 *
 *   _meta:
 *     ai.nimblebrain/connector:
 *       account:
 *         tool: ZOOM_GET_USER
 *         arguments: { userId: me }
 *         field: data.email
 *
 * The declaration makes the host call that tool with those arguments on the
 * connection's own credential, so it is read from the operator's catalog entry
 * and applies only to a connector bound to that entry (`bindCatalogEntry`).
 */

/** A parsed `account` declaration. */
export interface AccountLookup {
  /** The connector's tool that answers for the signed-in account, by its bare name. */
  readonly tool: string;
  /** Arguments the tool is called with. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Dotted path to the account label in the tool's JSON answer. */
  readonly field: string;
}

/** A JSON object: not an array, not null. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an entry's `account` block. A block the runtime cannot read declares
 * nothing: the label is display-only, so the connector works the same without
 * it and simply shows no account.
 */
export function parseAccountLookup(raw: unknown): AccountLookup | undefined {
  if (!isRecord(raw)) return undefined;
  const tool = typeof raw.tool === "string" ? raw.tool.trim() : "";
  const field = typeof raw.field === "string" ? raw.field.trim() : "";
  if (!tool || !field) return undefined;
  if (raw.arguments !== undefined && !isRecord(raw.arguments)) return undefined;
  return { tool, field, arguments: raw.arguments ?? {} };
}
