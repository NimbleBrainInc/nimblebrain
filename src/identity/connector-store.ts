import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { serverNameFromRef } from "../bundles/paths.ts";
import type { BundleRef } from "../bundles/types.ts";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import { IdentityContext } from "./context.ts";

/**
 * Per-user connector install record — the identity-plane analog of the
 * `bundles[]` slice of `workspace.json`.
 *
 * A personal connector is a remote MCP connection a user installs on their
 * own identity (Gmail / Granola / Composio / …), reachable across every
 * workspace they belong to and grantable into shared rooms. Its *metadata*
 * — what to start (URL, transport, UI, connector-skill overlays) — lives
 * here, at `users/<userId>/connectors.json`. Its *credentials* live
 * separately at `users/<userId>/credentials/mcp-oauth/<serverName>/`
 * (the `WorkspaceOAuthProvider` `{ type: "user" }` arm), mirroring the
 * workspace split (metadata in `workspace.json`, tokens under
 * `workspaces/<wsId>/credentials/mcp-oauth/`).
 *
 * Ownership is **structural**: a ref stored here is user-owned by virtue of
 * its location, not a field on the ref. Refs carry no `oauthScope` — the
 * `"user"` scope value was removed from the `BundleRef` union in Stage 2, and
 * a `"workspace"` scope would be meaningless off any workspace. The source
 * holder that reads this record constructs a `{ type: "user" }` OAuth provider
 * because the ref came from `connectors.json`, not from any workspace.
 *
 * Storage discipline mirrors `WorkspaceStore`: read-modify-write with an
 * atomic (`rename(2)`) commit via `writeJsonAtomic`. No file lock — like
 * `workspace.json`, concurrent writes to one user's record are rare (a user
 * clicking install), and a lost update is re-suppliable on retry.
 */

const RECORD_VERSION = 1 as const;
const RECORD_FILENAME = "connectors.json";

/**
 * On-disk shape of `users/<userId>/connectors.json`. `version` is reserved
 * for a future record migration; only `1` exists today.
 */
interface IdentityConnectorRecord {
  version: typeof RECORD_VERSION;
  connectors: BundleRef[];
}

export class IdentityConnectorStore {
  readonly #workDir: string;

  constructor(opts: { workDir: string }) {
    if (typeof opts.workDir !== "string" || opts.workDir.length === 0) {
      throw new Error(`[identity-connector-store] workDir is required (got "${opts.workDir}")`);
    }
    this.#workDir = opts.workDir;
  }

  /**
   * Absolute path to a user's connector record. Routes through
   * `IdentityContext`, so the `userId` is traversal-validated before it
   * reaches the filesystem — the single typed access path for
   * `users/<userId>/...`.
   */
  #recordPath(userId: string): string {
    return new IdentityContext({ userId, workDir: this.#workDir }).getDataPath(
      "root",
      RECORD_FILENAME,
    );
  }

  /**
   * Every connector installed on this identity, in install order. Returns
   * `[]` when the user has no record yet (the file is absent) — an
   * uninstalled identity is indistinguishable from an empty one, by design.
   */
  async list(userId: string): Promise<BundleRef[]> {
    let content: string;
    try {
      content = await readFile(this.#recordPath(userId), "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const record = JSON.parse(content) as IdentityConnectorRecord;
    // Defensive against a hand-edited / partial file: a record missing its
    // array reads as empty rather than throwing. A JSON *syntax* error still
    // propagates — a corrupt record is a real fault the caller must see.
    return Array.isArray(record.connectors) ? record.connectors : [];
  }

  /**
   * The connector with the given `serverName`, or `null`. `serverName` is the
   * lifecycle/route key (`serverNameFromRef`), the same key install stamps and
   * dispatch resolves on.
   */
  async get(userId: string, serverName: string): Promise<BundleRef | null> {
    const connectors = await this.list(userId);
    return connectors.find((ref) => serverNameFromRef(ref) === serverName) ?? null;
  }

  /**
   * Upsert a connector by `serverName`: replace an existing entry with the
   * same server, else append. Keeping the record a set keyed by `serverName`
   * (at most one ref per server) is the invariant `get` and the source holder
   * rely on; a re-install therefore updates in place (and moves the entry to
   * the end). Returns the new list.
   */
  async add(userId: string, ref: BundleRef): Promise<BundleRef[]> {
    const serverName = serverNameFromRef(ref);
    const current = await this.list(userId);
    const next = current.filter((r) => serverNameFromRef(r) !== serverName);
    next.push(ref);
    await this.#write(userId, next);
    return next;
  }

  /**
   * Remove the connector with the given `serverName`. Returns `true` if one
   * was removed, `false` if no such connector existed (idempotent
   * uninstall — a no-op is not an error).
   */
  async remove(userId: string, serverName: string): Promise<boolean> {
    const current = await this.list(userId);
    const next = current.filter((r) => serverNameFromRef(r) !== serverName);
    if (next.length === current.length) return false;
    await this.#write(userId, next);
    return true;
  }

  async #write(userId: string, connectors: BundleRef[]): Promise<void> {
    const path = this.#recordPath(userId);
    // The user root may not exist yet (a fresh identity that has only ever
    // installed connectors). `recursive: true` is idempotent when it does.
    await mkdir(dirname(path), { recursive: true });
    const record: IdentityConnectorRecord = { version: RECORD_VERSION, connectors };
    await writeJsonAtomic(path, record);
  }
}
