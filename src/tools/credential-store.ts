import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ID_RE } from "../api/auth-middleware.ts";
import { Redacted } from "./redacted.ts";

/**
 * Workspace-scoped store for opaque secrets that don't fit the per-bundle
 * `user_config` shape — most importantly OAuth `client_secret` values
 * referenced from `workspace.json` via `{ ref: "credential", key: "..." }`.
 *
 * The interface is the boundary between call sites and the storage backend.
 * v1 ships a plaintext-on-disk implementation (`FileCredentialStore`) at
 * `~/.nimblebrain/workspaces/<wsId>/credentials/secrets/<key>` with mode
 * 0o600. A SaaS deployment will swap in an encrypted implementation
 * (envelope encryption with a workspace KEK held in KMS) without touching
 * any caller — the interface promises an opaque secret store, not a file
 * store.
 *
 * Returned values are wrapped in `Redacted<string>` so they survive any
 * accidental logger or stack-trace path as `"[redacted]"`. Code that needs
 * the actual secret calls `.reveal()` at the boundary (HTTP header,
 * token-endpoint exchange).
 */
export interface CredentialStore {
  /** Resolve a secret. Returns `null` if the key is not set. */
  get(wsId: string, key: string): Promise<Redacted<string> | null>;
  /** Set or replace a secret atomically. */
  put(wsId: string, key: string, value: string): Promise<void>;
  /** Remove a secret. No-op if absent. */
  delete(wsId: string, key: string): Promise<void>;
}

/**
 * Validate a key. We reuse the same shape as bundle-credential keys —
 * dotted-namespace, alphanumerics, hyphen, underscore — because the key
 * becomes a filesystem path component.
 *
 *   "hubspot.client_secret" ✓
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

function assertValidWsId(wsId: string): void {
  if (typeof wsId !== "string" || !WORKSPACE_ID_RE.test(wsId)) {
    throw new Error(`[credential-store] invalid wsId: "${wsId}".`);
  }
}

/**
 * Plaintext file-backed `CredentialStore`. Ships in v1 self-host. Each
 * secret lives in its own file at:
 *
 *   <workDir>/workspaces/<wsId>/credentials/secrets/<key>
 *
 * Files are written 0o600 via atomic temp+rename. The parent `secrets/`
 * directory is created with 0o700.
 *
 * This is "secure enough for trusted local disk" — it is NOT a SaaS-grade
 * solution. The interface above is the swap point.
 */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly workDir: string) {}

  private dir(wsId: string): string {
    assertValidWsId(wsId);
    return join(this.workDir, "workspaces", wsId, "credentials", "secrets");
  }

  private filePath(wsId: string, key: string): string {
    assertValidKey(key);
    return join(this.dir(wsId), key);
  }

  async get(wsId: string, key: string): Promise<Redacted<string> | null> {
    const path = this.filePath(wsId, key);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf-8");
    // Trim trailing newline for ergonomic CLI input (`echo "secret" > file`).
    return new Redacted(raw.replace(/\n$/, ""));
  }

  async put(wsId: string, key: string, value: string): Promise<void> {
    const dir = this.dir(wsId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(dir, 0o700);
    } catch {
      // mkdir succeeded; chmod failure is non-fatal — file mode 0o600 below
      // still protects the contents.
    }
    const path = this.filePath(wsId, key);
    const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, value, { encoding: "utf-8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  async delete(wsId: string, key: string): Promise<void> {
    const path = this.filePath(wsId, key);
    if (!existsSync(path)) return;
    try {
      await unlink(path);
    } catch {
      // Concurrent removal — fine.
    }
  }
}
