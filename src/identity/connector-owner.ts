/**
 * Who owns a connector's credentials + connection state: a workspace (shared,
 * used by every member) or a single user (personal, on the identity plane).
 *
 * This is the ONE owner shape used across the OAuth provider, the Composio
 * wiring, and the credential / connection paths — there is deliberately not a
 * second, provider-specific owner union. It drives both the on-disk credential
 * root (`workspaces/<wsId>/credentials/...` vs `users/<userId>/credentials/...`)
 * and the principal id a provider keys on.
 *
 * Pure type + a diagnostic accessor; imports nothing, so any layer can depend
 * on it without a cycle.
 */
export type ConnectorOwner =
  | { readonly type: "workspace"; readonly wsId: string }
  | { readonly type: "user"; readonly userId: string };

/** The owner's id, regardless of variant — for logging / diagnostics only. */
export function connectorOwnerId(owner: ConnectorOwner): string {
  return owner.type === "workspace" ? owner.wsId : owner.userId;
}

/**
 * A canonical key for an owner, for committing an owner to a signed/hashed value
 * (e.g. the composio-auth CSRF state). A workspace keeps its bare id — a `ws_…`
 * id is already namespaced, so an existing workspace binding stays byte-identical
 * — while a user gets an explicit `usr:` prefix. A workspace id and a user id can
 * therefore never hash to the same key (their forms don't overlap AND the user
 * is prefixed), so a callback can't be replayed against the wrong owner root.
 */
export function connectorOwnerKey(owner: ConnectorOwner): string {
  return owner.type === "workspace" ? owner.wsId : `usr:${owner.userId}`;
}
