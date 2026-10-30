import type { ManagedConnectorRegistry } from "../../connectors/providers/registry.ts";
import type { ConnectorOwner } from "../../identity/connector-owner.ts";
import { brokeredRef } from "./brokered.ts";
import type { ConnectorRef } from "./types.ts";

/**
 * Transport auth kinds that need no OAuth: `bearer` / `header` / `provider` carry
 * their own credential (presented or minted on demand), and `none` declares that
 * the server takes no credential at all. An allowlist, so a future interactive
 * auth type defaults to the OAuth path instead of silently boot-starting.
 */
const STATIC_AUTH_TYPES: readonly string[] = ["bearer", "header", "provider", "none"];

/**
 * A url connector has STATIC transport auth (`bearer` / `header` / `provider` /
 * `none`) when it needs no persisted OAuth tokens and no interactive "Connect":
 * it carries its own credential, or declares (`none`) that the server takes
 * none. A connector with no `auth` authenticates through the workspace OAuth
 * provider.
 *
 * Gate boot-start and connection-state decisions on this so a static-auth source
 * is not mistaken for an un-authenticated OAuth connector. Without it, a provider-
 * auth fleet source (artifacts / nimbletasks / web-search) is skipped at boot for
 * "no tokens" — tools never surface — and seeded `not_authenticated`, which the
 * UI renders as a "Connect" button that would spin a bogus OAuth flow against a
 * server that has no OAuth.
 *
 * Mirrors the `hasStaticAuth` short-circuit in `startConnectorSource`
 * (`startup.ts`): the two boot gates (`workspace-runtime.ts` boot-start,
 * `lifecycle.ts` `seedInstance`) consume the same predicate so all three agree.
 *
 * CAUTION: brokered connectors also carry static auth (`provider` today, `header`
 * on refs predating the credential-provider seam), so this returns true for them
 * too — correct for `startup.ts` (a broker never uses the OAuth provider). But a
 * broker may STILL need a per-owner connect, so the two boot gates must ask
 * {@link brokeredConnectionPresent} FIRST and fall back to this predicate only
 * when it declines to answer. Otherwise an unconnected brokered connector seeds
 * `running` and loses its Connect button.
 */
export function connectorHasStaticAuth(ref: ConnectorRef): boolean {
  return !!ref.transport?.auth && STATIC_AUTH_TYPES.includes(ref.transport.auth.type);
}

/**
 * Whether a brokered connector's owner has completed the per-owner connect its
 * provider requires — the question `connectorHasStaticAuth` cannot answer, asked of
 * the only thing that can.
 *
 * Three-valued on purpose. `undefined` means "not a question for a provider" —
 * the ref is runtime-native, its provider is not registered here, or that
 * provider has nothing to connect per-owner — and the caller falls back to the
 * generic static-auth / persisted-token check. `true` / `false` is the
 * provider's own verdict and wins.
 *
 * Shared by both boot gates (`workspace-runtime.ts` boot-start and
 * `lifecycle.ts` `seedUrlConnectionState`) so they cannot disagree about which
 * connectors are ready — they have before.
 */
export function brokeredConnectionPresent(
  managedConnectors: ManagedConnectorRegistry,
  ref: ConnectorRef,
  wsId: string,
  workDir: string,
): boolean | undefined {
  const brokered = brokeredRef(ref);
  if (!brokered) return undefined;
  const hasConnection = managedConnectors.get(brokered.provider)?.hasConnection;
  if (!hasConnection) return undefined;
  const owner: ConnectorOwner = { type: "workspace", wsId };
  return hasConnection({ owner, brokered, workDir });
}
