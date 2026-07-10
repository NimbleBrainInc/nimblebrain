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
