import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../engine/types.ts";
import { IdentityContext } from "../identity/context.ts";
import { WorkspaceContext } from "../workspace/context.ts";
import { type CredentialValue, isCredentialRef } from "./credential-ref.ts";
import { Redacted } from "./redacted.ts";

/**
 * The scope a secret belongs to — which is to say, who owns it.
 *
 *   - `instance` — the operator's own keys: LLM providers, broker and gateway
 *     credentials, the IdP key. One set per deployment, referenced from
 *     `nimblebrain.json` / `instance.json`, and writable only from the CLI or
 *     the config file. No tenant reaches this scope.
 *   - `workspace` — a workspace's shared secrets: an OAuth `client_secret`, a
 *     connection string a customer owns. Two workspaces that install the same
 *     connector hold independent values, so an installed catalog entry can
 *     point at "the workspace's key" and mean a different secret per tenant.
 *   - `user` — an identity's own secrets, reachable across the workspaces they
 *     belong to. The home a personal connector's records move onto.
 *
 * A discriminated union rather than an optional `wsId`, because the three roots
 * are genuinely different owners and a missing id must be a type error, not a
 * silent fall back to a pooled directory.
 */
export type CredentialScope =
  | { kind: "instance" }
  | { kind: "workspace"; wsId: string }
  | { kind: "user"; userId: string };

/** Stable, loggable rendering of a scope — `instance`, `workspace:ws_…`, `user:usr_…`. */
export function credentialScopeLabel(scope: CredentialScope): string {
  switch (scope.kind) {
    case "instance":
      return "instance";
    case "workspace":
      return `workspace:${scope.wsId}`;
    case "user":
      return `user:${scope.userId}`;
  }
}

/**
 * Who is reading a secret and why. Required on every `get`, and stamped on the
 * audit event the returned secret emits when it is actually revealed.
 *
 * `caller` is the code path (`transport:header`, `oauth:client_secret`), stable
 * enough to group by. `purpose` is the concrete thing being done (`connect
 * ai-granola-mcp`), which is what makes a line in the log answer "why did this
 * key get read at 03:14".
 */
export interface CredentialRead {
  caller: string;
  purpose: string;
}

/** One key's presence and age. Never its value — this is what listing returns. */
export interface CredentialKeyInfo {
  key: string;
  /** Last write, ISO 8601. */
  updatedAt: string;
}

/**
 * The one door every secret goes through.
 *
 * The interface is the boundary between call sites and the storage backend. v1
 * ships plaintext-on-disk (`FileCredentialStore`); a SaaS deployment swaps in
 * envelope encryption with a per-scope KEK in KMS without touching a caller.
 * That promise is only worth something while this is the ONLY path, which is
 * why the store is constructed once (at the composition root, where the event
 * sink lives) and reached through `runtime.getCredentialStore()` rather than
 * built where it is needed.
 *
 * Values come back wrapped in `Redacted<string>` so they survive an accidental
 * logger or stack trace as `"[redacted]"`. Code that needs the actual secret
 * calls `.reveal()` at the boundary it is used (HTTP header, token exchange) —
 * and that call is what emits the audit event, so a presence probe that never
 * reveals costs no log line.
 */
export interface CredentialStore {
  /** Resolve a secret. Returns `null` if the key is not set. */
  get(scope: CredentialScope, key: string, read: CredentialRead): Promise<Redacted<string> | null>;
  /** Set or replace a secret atomically. */
  put(scope: CredentialScope, key: string, value: string): Promise<void>;
  /** Remove a secret. No-op if absent. */
  delete(scope: CredentialScope, key: string): Promise<void>;
  /** Every key set in a scope, with its last-write time. Never any value. */
  list(scope: CredentialScope): Promise<CredentialKeyInfo[]>;
}

/**
 * Validate a key. We reuse the same shape as bundle-credential keys —
 * dotted-namespace, alphanumerics, hyphen, underscore — because the key
 * becomes a filesystem path component.
 *
 *   "acme.db_url"           ✓
 *   "google.oauth-client"   ✓
 *   "../evil"               ✗
 *   "with/slash"            ✗
 */
const KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function assertValidKey(key: string): void {
  if (typeof key !== "string" || !KEY_RE.test(key) || key === "." || key === "..") {
    throw new Error(
      `[credential-store] invalid key: "${key}". ` +
        `Must match /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/ and not be "." or "..".`,
    );
  }
}

/** Thrown when a config reference names a key the store has nothing for. */
export class CredentialNotFoundError extends Error {
  constructor(
    readonly scope: CredentialScope,
    readonly key: string,
    what: string,
  ) {
    super(
      `[credential-store] no secret at key "${key}" in scope ${credentialScopeLabel(scope)} ` +
        `(needed for ${what}). Set it with manage_connectors set_secret, or remove the reference.`,
    );
    this.name = "CredentialNotFoundError";
  }
}

/**
 * A secret that reports its own use.
 *
 * The audit event fires on `reveal()`, not on the read that produced it, so the
 * log records secrets that were *presented* rather than secrets that were
 * looked up. That distinction is load-bearing: the connectors list probes for a
 * configured `client_secret` on every catalog entry it renders, and auditing
 * those probes would bury the handful of real uses under a page-load's worth of
 * noise while claiming each was a use.
 *
 * Emitted at most once per instance. One `get` yields one line however many
 * times its value is presented — otherwise a long-lived `fetch` wrapper holding
 * one secret would write a line per outbound HTTP request.
 */
class AuditedSecret extends Redacted<string> {
  #onFirstReveal: (() => void) | undefined;

  constructor(value: string, onFirstReveal: () => void) {
    super(value);
    this.#onFirstReveal = onFirstReveal;
  }

  override reveal(): string {
    const emit = this.#onFirstReveal;
    if (emit) {
      this.#onFirstReveal = undefined;
      emit();
    }
    return super.reveal();
  }
}

/**
 * Plaintext file-backed `CredentialStore`. Ships in v1 self-host. Each secret
 * lives in its own file under its scope's root:
 *
 *   instance   <workDir>/credentials/secrets/<key>
 *   workspace  <workDir>/workspaces/<wsId>/credentials/secrets/<key>
 *   user       <workDir>/users/<userId>/credentials/secrets/<key>
 *
 * Files are written 0o600 via atomic temp+rename; the parent `secrets/`
 * directory is created 0o700. A `put` on an existing key replaces it in place,
 * which is the whole of rotation — the next read gets the new value and no
 * config was touched.
 *
 * This is "secure enough for trusted local disk" — it is NOT a SaaS-grade
 * solution. `CredentialStore` above is the swap point.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #workDir: string;
  readonly #eventSink: EventSink | undefined;

  constructor(workDir: string, opts?: { eventSink?: EventSink }) {
    this.#workDir = workDir;
    this.#eventSink = opts?.eventSink;
  }

  /**
   * The secrets directory for a scope.
   *
   * Every arm routes through the typed context that owns its tree —
   * `WorkspaceContext` for a workspace, `IdentityContext` for a user — so the id
   * is validated at the single place that validates it and no arm hand-builds a
   * path under `workspaces/` or `users/`. The instance arm has no owner tree
   * above it; `<workDir>/credentials/` is its root by definition.
   */
  #dir(scope: CredentialScope): string {
    switch (scope.kind) {
      case "instance":
        return join(this.#workDir, "credentials", "secrets");
      case "workspace":
        return new WorkspaceContext({ wsId: scope.wsId, workDir: this.#workDir }).getDataPath(
          "credentials",
          "secrets",
        );
      case "user":
        return join(
          new IdentityContext({ userId: scope.userId, workDir: this.#workDir }).getRoot(),
          "credentials",
          "secrets",
        );
    }
  }

  #filePath(scope: CredentialScope, key: string): string {
    assertValidKey(key);
    return join(this.#dir(scope), key);
  }

  async get(
    scope: CredentialScope,
    key: string,
    read: CredentialRead,
  ): Promise<Redacted<string> | null> {
    const path = this.#filePath(scope, key);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    // Trim trailing newline for ergonomic CLI input (`echo "secret" > file`).
    const value = raw.replace(/\n$/, "");
    return new AuditedSecret(value, () => this.#auditReveal(scope, key, read));
  }

  async put(scope: CredentialScope, key: string, value: string): Promise<void> {
    const dir = this.#dir(scope);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dir, 0o700);
    } catch {
      // mkdir succeeded; chmod failure is non-fatal — file mode 0o600 below
      // still protects the contents.
    }
    const path = this.#filePath(scope, key);
    const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, value, { encoding: "utf-8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  async delete(scope: CredentialScope, key: string): Promise<void> {
    const path = this.#filePath(scope, key);
    if (!existsSync(path)) return;
    try {
      await unlink(path);
    } catch {
      // Concurrent removal — fine.
    }
  }

  async list(scope: CredentialScope): Promise<CredentialKeyInfo[]> {
    const dir = this.#dir(scope);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // No directory means no secrets, which is a legitimate empty answer.
      return [];
    }
    const out: CredentialKeyInfo[] = [];
    for (const name of names) {
      // A `put` that died between write and rename leaves a temp file. It is
      // not a key and must not read as one.
      if (!KEY_RE.test(name)) continue;
      try {
        const s = await stat(join(dir, name));
        if (!s.isFile()) continue;
        out.push({ key: name, updatedAt: new Date(s.mtimeMs).toISOString() });
      } catch {
        // Removed between readdir and stat.
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  #auditReveal(scope: CredentialScope, key: string, read: CredentialRead): void {
    const event: EngineEvent = {
      type: "audit.credential_read",
      data: {
        scope: credentialScopeLabel(scope),
        key,
        caller: read.caller,
        purpose: read.purpose,
        ...(scope.kind === "workspace" ? { workspaceId: scope.wsId } : {}),
        ...(scope.kind === "user" ? { userId: scope.userId } : {}),
      },
    };
    this.#eventSink?.emit(event);
  }
}

// ── The installed store ──────────────────────────────────────────────

let _installed: CredentialStore | undefined;

/**
 * Install the process's credential store. Called once at the composition root
 * (`Runtime.start`), which is the only place that holds both the work directory
 * and the event sink a read must be attributable through.
 *
 * A module-level handle rather than a threaded argument because the readers are
 * leaves — `remote-transport.ts` resolving a header reference, the boot-time
 * instance-key resolution — and threading a store through the transport factory
 * would put it in every caller's signature to serve the one case that dereferences.
 */
export function setCredentialStore(store: CredentialStore): void {
  _installed = store;
}

/**
 * The installed store. Throws when nothing installed one, because the only way
 * to reach here is a config reference that has to be resolved: answering
 * "there is no store" with an empty value would turn a missing secret into a
 * blank header and a 401 a hop away.
 */
export function requireCredentialStore(): CredentialStore {
  if (!_installed) {
    throw new Error(
      '[credential-store] no credential store installed; a `{ ref: "credential" }` ' +
        "reference cannot be resolved (call setCredentialStore() at the composition root)",
    );
  }
  return _installed;
}

/** The installed store, or undefined. For callers that have a literal fallback. */
export function getCredentialStore(): CredentialStore | undefined {
  return _installed;
}

/** Test-only. Drop the installed store so a suite starts from none. */
export function _resetCredentialStoreForTest(): void {
  _installed = undefined;
}

/**
 * Resolve a config field that is either the secret itself or a reference to one.
 *
 * The single dereference site. A literal passes through untouched — the
 * reference is an option, not a requirement — and a reference to a key with no
 * value throws {@link CredentialNotFoundError}, naming both the key and the
 * scope. Failing loud is the point: the alternative is an empty header and a
 * vendor 401 that names neither.
 */
export async function resolveCredentialValue(
  value: CredentialValue,
  scope: CredentialScope,
  read: CredentialRead,
): Promise<string> {
  if (!isCredentialRef(value)) return value;
  const wrapped = await requireCredentialStore().get(scope, value.key, read);
  if (!wrapped) throw new CredentialNotFoundError(scope, value.key, read.purpose);
  return wrapped.reveal();
}
