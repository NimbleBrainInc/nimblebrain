import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { log } from "../observability/log.ts";
import {
  type CredentialRead,
  type CredentialScope,
  type CredentialStore,
  requireCredentialStore,
} from "./credential-store.ts";

/**
 * The records an OAuth connection persists per `(owner, server)`.
 *
 *   - `tokens`   — the access + refresh token pair.
 *   - `verifier` — the PKCE verifier for the flow in progress.
 *   - `client`   — the DCR registration. For a confidential client this
 *                  carries a `client_secret`.
 *   - `identity` — OIDC claims (`sub` / `email` / `name`) from an `id_token`
 *                  or the userinfo endpoint, so the UI can say "Connected as …".
 *
 *   - `auth_lost` — a flag, not a secret: the connection's credential was
 *                  rejected upstream (revoked, expired) and nobody has
 *                  reconnected or disconnected since. It outlives the tokens
 *                  the SDK deletes on `invalid_grant`, so a restart still tells
 *                  a broken connection (`reauth_required`) from one the user
 *                  disconnected (`not_authenticated`). Workspace scope only.
 *
 * Three are secrets of the same class as the `client_secret` the credential
 * store was built for, and the rest are bound to them, so all go through the
 * same door and are deleted together. The store never learns their shape: each
 * value is a JSON string it holds opaquely.
 */
export type McpOAuthRecord = "tokens" | "verifier" | "client" | "identity" | "auth_lost";

const ALL_RECORDS: readonly McpOAuthRecord[] = [
  "tokens",
  "verifier",
  "client",
  "identity",
  "auth_lost",
];

/** Key namespace for every OAuth record. */
const MCP_OAUTH = "mcp-oauth";

/**
 * The credential-store key for one record: `mcp-oauth.<serverName>.<record>`.
 *
 * Dotted namespace, matching the store's key grammar (`assertValidKey`), which
 * `serverName` already satisfies — {@link assertSafeServerName} enforces the
 * same character set at every entry point here.
 */
export function mcpOAuthKey(serverName: string, record: McpOAuthRecord): string {
  return `${MCP_OAUTH}.${serverName}.${record}`;
}

/** The credential scope an owner's records live in. */
export function credentialScopeForOwner(owner: ConnectorOwner): CredentialScope {
  return owner.type === "workspace"
    ? { kind: "workspace", wsId: owner.wsId }
    : { kind: "user", userId: owner.userId };
}

/**
 * Validate a server name before it composes into a store key. Same
 * shape as the credential-store key validator (alphanumerics + `._-`,
 * length-bounded, no `.` / `..`), so owner ids, server names, and credential
 * keys have one safe-name story.
 */
const SAFE_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function assertSafeServerName(name: string): void {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 128 ||
    !SAFE_NAME_RE.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(
      `[mcp-oauth-records] invalid name: "${name}". ` +
        "Must be 1-128 chars matching /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.",
    );
  }
}

/**
 * One OAuth connection's records, behind the credential store.
 *
 * The provider owns the OAuth state machine; this owns where its records live —
 * which, since a token is a secret of the same class as a `client_secret`, is
 * the same door every other secret goes through. Values are JSON strings; the
 * `<T>` on {@link read} is the caller's assertion about what it wrote.
 */
export class McpOAuthRecords {
  readonly #scope: CredentialScope;
  readonly #serverName: string;
  readonly #store: CredentialStore | undefined;

  constructor(opts: {
    owner: ConnectorOwner;
    serverName: string;
    /** Test seam. Production leaves this unset and reaches the installed store. */
    store?: CredentialStore;
  }) {
    assertSafeServerName(opts.serverName);
    this.#scope = credentialScopeForOwner(opts.owner);
    this.#serverName = opts.serverName;
    this.#store = opts.store;
  }

  #resolveStore(): CredentialStore {
    return this.#store ?? requireCredentialStore();
  }

  /**
   * Read one record, or `null` when it is not set. A parse failure reads as
   * absent — corrupt state is state we cannot act on, and every caller's next
   * move (re-register, re-auth) is the right response to both.
   */
  async read<T>(record: McpOAuthRecord, read: CredentialRead): Promise<T | null> {
    const wrapped = await this.#resolveStore().get(
      this.#scope,
      mcpOAuthKey(this.#serverName, record),
      read,
    );
    if (!wrapped) return null;
    // Narrow: only a parse failure means "treat it as absent". A record whose
    // bytes are sealed and cannot be opened is NOT a missing record — swallowing
    // that would answer "not connected" for a connection that is, silently
    // discarding live tokens and re-running the OAuth dance over a secret the
    // operator can still recover by restoring the key.
    let raw: string;
    try {
      raw = wrapped.reveal();
    } catch (err) {
      log.warn(`[oauth] ${this.#serverName} ${record} record could not be opened: ${String(err)}`);
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      log.debug(
        "mcp",
        `[oauth] ${this.#serverName} ${record} record is not valid JSON: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * Whether a record is set, without reading it. The store's audit line fires
   * on `reveal()`, which this never calls, so a probe costs nothing in the log
   * — which is what lets connection-state derivation run over every installed
   * connector on a page load.
   */
  async has(record: McpOAuthRecord): Promise<boolean> {
    return (
      (await this.#resolveStore().get(this.#scope, mcpOAuthKey(this.#serverName, record), {
        caller: "oauth:records",
        purpose: `probe ${record} for ${this.#serverName}`,
      })) !== null
    );
  }

  /** Set or replace a record. */
  async write(record: McpOAuthRecord, value: unknown): Promise<void> {
    await this.#resolveStore().put(
      this.#scope,
      mcpOAuthKey(this.#serverName, record),
      JSON.stringify(value, null, 2),
    );
  }

  /** Remove a record. No-op if absent. */
  async delete(record: McpOAuthRecord): Promise<void> {
    await this.#resolveStore().delete(this.#scope, mcpOAuthKey(this.#serverName, record));
  }

  /**
   * Remove every record for this connection — the teardown a disconnect or an
   * uninstall performs. Keys, not a directory: the records are keys in a
   * scope that holds other connectors' keys too, so there is nothing here whose
   * removal can take a neighbour with it.
   */
  async deleteAll(): Promise<void> {
    for (const record of ALL_RECORDS) {
      await this.#resolveStore().delete(this.#scope, mcpOAuthKey(this.#serverName, record));
    }
  }
}

/**
 * Whether an `(owner, server)` has persisted OAuth tokens — i.e. the connector
 * completed its Connect flow at least once. Presence only (it survives a pod
 * restart), NOT validity: token expiry / revocation detection is the reauth
 * slice's job. Used to render "connected" for an authed connector whose source
 * isn't warm in the current pod, so the profile doesn't offer a spurious
 * re-Connect, and to decide whether a boot-time URL connector has anything to
 * auto-start with.
 */
export async function hasMcpOAuthTokens(
  owner: ConnectorOwner,
  serverName: string,
): Promise<boolean> {
  return new McpOAuthRecords({ owner, serverName }).has("tokens");
}

/**
 * Whether an `(owner, server)` carries the `auth_lost` flag — its credential
 * was rejected upstream and nobody has reconnected or disconnected since. The
 * boot seed reads it to record `reauth_required` rather than
 * `not_authenticated` once the SDK has deleted the rejected tokens.
 */
export async function hasMcpOAuthAuthLost(
  owner: ConnectorOwner,
  serverName: string,
): Promise<boolean> {
  return new McpOAuthRecords({ owner, serverName }).has("auth_lost");
}

/**
 * Drop the `auth_lost` flag. Disconnect calls it after the live source is torn
 * down, so a refresh still in flight on that source cannot re-set it.
 */
export async function clearMcpOAuthAuthLost(
  owner: ConnectorOwner,
  serverName: string,
): Promise<void> {
  await new McpOAuthRecords({ owner, serverName }).delete("auth_lost");
}
