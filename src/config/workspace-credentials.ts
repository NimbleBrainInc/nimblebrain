import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Workspace-scoped credential store.
 *
 * Per-bundle credentials live at:
 *   {workDir}/workspaces/{wsId}/credentials/{bundle-slug}.json
 *
 * File format is plain JSON key-value — no metadata envelope:
 *   { "api_key": "sk-...", "workspace_id": "ws-..." }
 *
 * This is tier 1 of the 4-tier credential resolution hierarchy described in
 * `.tasks/credential-resolution/SPEC_REFERENCE.md`. This module implements the
 * file-level CRUD only. The tier resolver lives in `resolveUserConfig` (task 003).
 *
 * Security: files are written with `0o600`, the `credentials/` directory is
 * created with `0o700`, and writes are atomic (temp file + rename). Credential
 * values are never logged; only keys appear in diagnostics.
 */

// ── Path helpers ──────────────────────────────────────────────────

/**
 * Derive a filesystem-safe slug from a bundle name.
 *
 *   `@nimblebraininc/newsapi` → `nimblebraininc-newsapi`
 *   `newsapi`                 → `newsapi`
 *
 * Strips a leading `@` and replaces `/` with `-`. Scope is preserved so
 * same-named bundles from different scopes don't collide.
 */
export function bundleSlug(bundleName: string): string {
  return bundleName.replace(/^@/, "").replace(/\//g, "-");
}

/** Absolute path to the credentials directory for a workspace. */
function credentialsDir(wsId: string, workDir: string): string {
  return join(workDir, "workspaces", wsId, "credentials");
}

/** Absolute path to the credential file for a bundle in a workspace. */
export function credentialPath(wsId: string, bundleName: string, workDir: string): string {
  return join(credentialsDir(wsId, workDir), `${bundleSlug(bundleName)}.json`);
}

// ── Atomic write helper ───────────────────────────────────────────

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

/**
 * Write `content` to `path` atomically with the requested mode.
 * Writes to `{path}.tmp.{timestamp}.{counter}` then renames into place so
 * readers never observe a partial file.
 */
async function atomicWriteFile(path: string, content: string, mode: number): Promise<void> {
  const tmpPath = `${path}.tmp.${uniqueTmpSuffix()}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  // `writeFile`'s mode can be affected by umask on some platforms; enforce explicitly.
  await chmod(tmpPath, mode);
  await rename(tmpPath, path);
}

/**
 * Ensure the `credentials/` directory for a workspace exists with `0o700`.
 * Also enforces the mode if the directory already exists.
 */
async function ensureCredentialsDir(wsId: string, workDir: string): Promise<string> {
  const dir = credentialsDir(wsId, workDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mkdir({ mode })` only applies to newly created directories; harden the
  // final leaf regardless (cheap no-op when already correct).
  await chmod(dir, 0o700).catch(() => {
    // If chmod fails (e.g. not the owner), leave the directory alone — the
    // store itself will still refuse to write to a world-readable file via
    // the atomic write's explicit mode, and the read path warns.
  });
  return dir;
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Read and parse the credential file for `bundleName` in workspace `wsId`.
 *
 * Returns `null` if the file does not exist (not an error — missing creds are
 * normal; the caller falls through to the next tier). If the file exists but
 * has a mode other than `0o600`, a warning is written to stderr.
 */
export async function getWorkspaceCredentials(
  wsId: string,
  bundleName: string,
  workDir: string,
): Promise<Record<string, string> | null> {
  const filePath = credentialPath(wsId, bundleName, workDir);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  // Permission check. The file existed, so we expect 0o600. Only the 9 mode
  // bits are relevant — higher bits (setuid/setgid/sticky) and file-type bits
  // would never be set on our files.
  try {
    const st = await stat(filePath);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      const octal = mode.toString(8).padStart(3, "0");
      // Do not include credential values; the path is sufficient to act.
      console.warn(
        `[workspace-credentials] insecure permissions on ${filePath}: ` +
          `mode=0${octal} (expected 0600). Run: chmod 600 ${filePath}`,
      );
    }
  } catch {
    // stat shouldn't fail right after readFile succeeded, but if it does we
    // still have valid JSON to return — don't block on the permission check.
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`[workspace-credentials] credential file is not a JSON object: ${filePath}`);
    }
    // Coerce non-string values defensively — the schema is <string, string>.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `[workspace-credentials] failed to parse credential file ${filePath}: ${err.message}`,
      );
    }
    throw err;
  }
}

// ── Write ─────────────────────────────────────────────────────────

/**
 * Save a single `key=value` credential for `bundleName` in workspace `wsId`.
 *
 * Merges with any existing values in the file — other keys are preserved.
 * Parent directories are created as needed (`credentials/` with `0o700`) and
 * the credential file is written with `0o600` via an atomic temp + rename.
 */
export async function saveWorkspaceCredential(
  wsId: string,
  bundleName: string,
  key: string,
  value: string,
  workDir: string,
): Promise<void> {
  await ensureCredentialsDir(wsId, workDir);
  const filePath = credentialPath(wsId, bundleName, workDir);

  const existing = (await getWorkspaceCredentials(wsId, bundleName, workDir)) ?? {};
  const merged: Record<string, string> = { ...existing, [key]: value };

  await atomicWriteFile(filePath, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
}

/**
 * Remove a single credential key for `bundleName` in workspace `wsId`.
 *
 * Returns `true` if the key was present (and was removed), `false` otherwise.
 * If removing the key leaves the file empty, the file is deleted.
 */
export async function clearWorkspaceCredential(
  wsId: string,
  bundleName: string,
  key: string,
  workDir: string,
): Promise<boolean> {
  const existing = await getWorkspaceCredentials(wsId, bundleName, workDir);
  if (!existing || !(key in existing)) return false;

  const { [key]: _removed, ...rest } = existing;
  const filePath = credentialPath(wsId, bundleName, workDir);

  if (Object.keys(rest).length === 0) {
    await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    return true;
  }

  await atomicWriteFile(filePath, `${JSON.stringify(rest, null, 2)}\n`, 0o600);
  return true;
}

/**
 * Remove the entire credential file for `bundleName` in workspace `wsId`.
 * Returns `true` if the file existed (and was removed), `false` otherwise.
 */
export async function clearAllWorkspaceCredentials(
  wsId: string,
  bundleName: string,
  workDir: string,
): Promise<boolean> {
  const filePath = credentialPath(wsId, bundleName, workDir);
  try {
    await unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
