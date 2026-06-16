import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * The credential a provider attaches to a remote MCP transport: either static
 * headers, or a `fetch` wrapper that injects (and re-mints) a token per request.
 */
export interface TransportCredential {
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

/**
 * Produces the credential for a remote MCP connection. This is the kernel's ONE
 * generic seam for non-interactive, preconfigured machine-plane auth — the thing
 * `bearer`/`header`/minted-token all are, viewed as "attach a credential."
 *
 * `config` is OPAQUE to the kernel: it comes from the source's vetted transport
 * auth config, which (for catalog connectors) originates from the operator-
 * published catalog entry — NEVER from tenant input. So the kernel never learns
 * what a provider means (issuer, audience, fleet, …); it just asks for a
 * credential for `(workspaceId, config)` and presents it.
 */
export interface TransportCredentialProvider {
  credentialFor(
    workspaceId: string | undefined,
    config: Record<string, unknown>,
  ): TransportCredential;
}

const REGISTRY = new Map<string, TransportCredentialProvider>();

/** Register a named credential provider. Called at the composition root (and by
 *  tests). Re-registration overwrites — last writer wins. */
export function registerCredentialProvider(
  name: string,
  provider: TransportCredentialProvider,
): void {
  REGISTRY.set(name, provider);
}

/** Look up a registered provider by name, or undefined if none is registered. */
export function getCredentialProvider(name: string): TransportCredentialProvider | undefined {
  return REGISTRY.get(name);
}
