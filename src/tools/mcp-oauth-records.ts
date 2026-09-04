import { existsSync } from "node:fs";
import { readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConnectorOwner } from "../identity/connector-owner.ts";
import { log } from "../observability/log.ts";
import {
  type CredentialRead,
  type CredentialScope,
  type CredentialStore,
  requireCredentialStore,
} from "./credential-store.ts";
import type { Redacted } from "./redacted.ts";

/**
 * The four records an OAuth connection persists per `(owner, server)`.
 *
 *   - `tokens`   — the access + refresh token pair.
 *   - `verifier` — the PKCE verifier for the flow in progress.
 *   - `client`   — the DCR registration. For a confidential client this
 *                  carries a `client_secret`.
 *   - `identity` — OIDC claims lifted from an `id_token` (`sub` / `email` /
 *                  `name`), so the UI can say "Connected as …".
 *
 * Three of the four are secrets of the same class as the `client_secret` the
 * credential store was built for, and the fourth is bound 1:1 to them, so all
 * four go through the same door. The store never learns their shape: each value
 * is a JSON string it holds opaquely.
 */
export type McpOAuthRecord = "tokens" | "verifier" | "client" | "identity";

const ALL_RECORDS: readonly McpOAuthRecord[] = ["tokens", "verifier", "client", "identity"];

/**
 * Key namespace for every OAuth record. Also the legacy directory name — the
 * one place the two spellings are the same string, so the migration below and
 * the key builder cannot drift apart.
 */
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
 * Validate an id before it composes into a filesystem path or a store key. Same
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
 * The pre-store home of these records: `<owner-root>/credentials/mcp-oauth/
 * <serverName>/`, holding `tokens.json` / `verifier.json` / `client.json` /
 * `identity.json` as plaintext.
 *
 * Nothing writes here any more. It exists so {@link McpOAuthRecords} can carry
 * an installation that predates the store across and then delete what it no
 * longer needs — the whole of the migration, with no maintenance window and no
 * script. When no deployment can still be carrying these files, this function
 * and every caller of it go, and the `mcp-oauth` carve-out in
 * `check:credential-paths` goes with them.
 */
export function legacyMcpOAuthDir(
  workDir: string,
  owner: ConnectorOwner,
  serverName: string,
): string {
  const ownerSegment = owner.type === "workspace" ? "workspaces" : "users";
  const ownerId = owner.type === "workspace" ? owner.wsId : owner.userId;
  assertSafeServerName(ownerId);
  assertSafeServerName(serverName);
  return join(workDir, ownerSegment, ownerId, "credentials", MCP_OAUTH, serverName);
}

/**
 * One OAuth connection's records, behind the credential store.
 *
 * The provider owns the OAuth state machine; this owns where its records live —
 * which, since a token is a secret of the same class as a `client_secret`, is
 * the same door every other secret goes through. Values are JSON strings; the
 * `<T>` on {@link read} is the caller's assertion about what it wrote, exactly
 * as it was when these were files.
 *
 * A legacy file is retired on the record's first touch (see
 * {@link legacyMcpOAuthDir}) — imported by a read, superseded by a write — so an
 * existing installation crosses over on its next use with nothing to run.
 */
export class McpOAuthRecords {
  readonly #scope: CredentialScope;
  readonly #serverName: string;
  readonly #legacyDir: string;
  readonly #store: CredentialStore | undefined;

  constructor(opts: {
    owner: ConnectorOwner;
    serverName: string;
    workDir: string;
    /** Test seam. Production leaves this unset and reaches the installed store. */
    store?: CredentialStore;
  }) {
    assertSafeServerName(opts.serverName);
    this.#scope = credentialScopeForOwner(opts.owner);
    this.#serverName = opts.serverName;
    this.#legacyDir = legacyMcpOAuthDir(opts.workDir, opts.owner, opts.serverName);
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
    const wrapped = await this.#resolve(record, read);
    if (!wrapped) return null;
    try {
      return JSON.parse(wrapped.reveal()) as T;
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
      (await this.#resolve(record, {
        caller: "oauth:records",
        purpose: `probe ${record} for ${this.#serverName}`,
      })) !== null
    );
  }

  /**
   * Set or replace a record, and retire the legacy file it supersedes.
   *
   * A record whose first touch is a write — `verifier`, which `saveCodeVerifier`
   * sets before anything reads it — would never reach {@link read}'s import, so
   * without this its plaintext file outlives the value it held.
   */
  async write(record: McpOAuthRecord, value: unknown): Promise<void> {
    await this.#resolveStore().put(
      this.#scope,
      mcpOAuthKey(this.#serverName, record),
      JSON.stringify(value, null, 2),
    );
    await this.#removeLegacyFile(record);
  }

  /** Remove a record. No-op if absent. */
  async delete(record: McpOAuthRecord): Promise<void> {
    await this.#resolveStore().delete(this.#scope, mcpOAuthKey(this.#serverName, record));
    await this.#removeLegacyFile(record);
  }

  /**
   * Remove every record for this connection — the teardown a disconnect or an
   * uninstall performs. Keys, not a directory: the records are four keys in a
   * scope that holds other connectors' keys too, so there is nothing here whose
   * removal can take a neighbour with it.
   */
  async deleteAll(): Promise<void> {
    for (const record of ALL_RECORDS) {
      await this.#resolveStore().delete(this.#scope, mcpOAuthKey(this.#serverName, record));
    }
    // A legacy dir can still be here when the connection was never read after
    // the upgrade — teardown must not leave plaintext tokens behind.
    await rm(this.#legacyDir, { recursive: true, force: true });
    await this.#pruneEmptyLegacyParent();
  }

  /**
   * The store's answer, importing a legacy file first when the key is unset.
   * Returns the store's own wrapper, unrevealed — so the caller decides whether
   * this is a use (which audits) or a probe (which does not).
   *
   * `put` before `unlink`: a crash between the two leaves both copies, and the
   * next read finds the key and removes the file. The reverse order loses the
   * record.
   */
  async #resolve(record: McpOAuthRecord, read: CredentialRead): Promise<Redacted<string> | null> {
    const store = this.#resolveStore();
    const key = mcpOAuthKey(this.#serverName, record);
    const wrapped = await store.get(this.#scope, key, read);
    if (wrapped) return wrapped;

    const legacyPath = join(this.#legacyDir, `${record}.json`);
    if (!existsSync(legacyPath)) return null;
    let raw: string;
    try {
      raw = await readFile(legacyPath, "utf-8");
    } catch (err) {
      log.debug("mcp", `[oauth] failed to read legacy ${legacyPath}: ${String(err)}`);
      return null;
    }
    await store.put(this.#scope, key, raw);
    await this.#removeLegacyFile(record);
    log.info(
      `[oauth] ${this.#serverName} migrated ${record} from ${MCP_OAUTH}/${record}.json into the credential store as "${key}"`,
    );
    // Re-read so the caller gets the store's wrapper for the value it now
    // holds — a hand-built one would carry no audit and no backend.
    return await store.get(this.#scope, key, read);
  }

  async #removeLegacyFile(record: McpOAuthRecord): Promise<void> {
    const path = join(this.#legacyDir, `${record}.json`);
    if (!existsSync(path)) return;
    try {
      await unlink(path);
    } catch {
      // Concurrent removal — fine.
    }
    await this.#pruneEmptyLegacyDir();
  }

  /** Drop `…/mcp-oauth/<server>/` once its last record has been imported. */
  async #pruneEmptyLegacyDir(): Promise<void> {
    if (await removeIfEmpty(this.#legacyDir)) await this.#pruneEmptyLegacyParent();
  }

  /** Drop `…/credentials/mcp-oauth/` once its last connector has crossed over. */
  async #pruneEmptyLegacyParent(): Promise<void> {
    await removeIfEmpty(dirname(this.#legacyDir));
  }
}

/** Remove a directory if it exists and is empty. Answers whether it went. */
async function removeIfEmpty(dir: string): Promise<boolean> {
  try {
    if ((await readdir(dir)).length > 0) return false;
    await rmdir(dir);
    return true;
  } catch {
    // Absent, non-empty by the time we got here, or not ours to remove.
    return false;
  }
}

/**
 * Whether an `(owner, server)` has persisted OAuth tokens — i.e. the connector
 * completed its Connect flow at least once. Presence only (it survives a pod
 * restart), NOT validity: token expiry / revocation detection is the reauth
 * slice's job. Used to render "connected" for an authed connector whose source
 * isn't warm in the current pod, so the profile doesn't offer a spurious
 * re-Connect, and to decide whether a boot-time URL bundle has anything to
 * auto-start with.
 */
export async function hasMcpOAuthTokens(
  workDir: string,
  owner: ConnectorOwner,
  serverName: string,
): Promise<boolean> {
  return new McpOAuthRecords({ owner, serverName, workDir }).has("tokens");
}
