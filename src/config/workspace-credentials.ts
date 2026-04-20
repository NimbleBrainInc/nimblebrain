import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MpakConfigError } from "@nimblebrain/mpak-sdk";
import { WORKSPACE_ID_RE } from "../workspace/workspace-store.ts";
import type { ConfirmationGate } from "./privilege.ts";

/**
 * Workspace-scoped credential store.
 *
 * Per-bundle credentials live at:
 *   {workDir}/workspaces/{wsId}/credentials/{bundle-slug}.json
 *
 * File format is plain JSON key-value — no metadata envelope:
 *   { "api_key": "sk-...", "workspace_id": "ws-..." }
 *
 * This is the tier-1 primitive for NimbleBrain's workspace-scoped credential
 * resolution. This module implements the file-level CRUD only; the tier
 * resolver layered on top is `resolveUserConfig` in the same module.
 *
 * Security posture:
 *   - Files are written with `0o600`, the `credentials/` directory is created
 *     with `0o700`, and writes are atomic (temp file + rename).
 *   - `wsId` is validated against `WORKSPACE_ID_RE` on every call because the
 *     path derived from it is a filesystem path — a caller passing `../evil`
 *     would otherwise escape the workspace tree. We don't trust the call site.
 *   - Credential values are never logged; only keys and paths appear in
 *     diagnostics.
 */

// ── Path helpers ──────────────────────────────────────────────────

/**
 * Derive a filesystem-safe slug from a bundle name.
 *
 *   `@nimblebraininc/newsapi` → `nimblebraininc-newsapi`
 *   `newsapi`                 → `newsapi`
 *
 * Strips a leading `@` and replaces path separators with `-`. Scope is
 * preserved so same-named bundles from different scopes don't collide.
 * Defensively handles `..` segments, null bytes, and Windows-style
 * separators so no possible bundleName can escape the credentials directory
 * or produce a shell-hostile filename. The result is matched against
 * `SLUG_RE` and throws on any characters that survive — better to fail
 * loudly than to silently write to an unexpected path.
 */
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
export function bundleSlug(bundleName: string): string {
  if (typeof bundleName !== "string" || bundleName.length === 0) {
    throw new Error(`[workspace-credentials] invalid bundle name: must be a non-empty string`);
  }
  // Normalize: strip leading @, collapse separators to `-`.
  const slug = bundleName.replace(/^@/, "").replace(/[/\\]/g, "-");
  if (!SLUG_RE.test(slug) || slug === "." || slug === "..") {
    throw new Error(
      `[workspace-credentials] invalid bundle name "${bundleName}": ` +
        `must contain only alphanumerics, dot, underscore, hyphen, and one optional @scope/ prefix`,
    );
  }
  return slug;
}

/** Assert `wsId` matches the shape enforced by `WorkspaceStore`. */
function assertValidWsId(wsId: string): void {
  if (typeof wsId !== "string" || !WORKSPACE_ID_RE.test(wsId)) {
    throw new Error(
      `[workspace-credentials] invalid wsId: "${wsId}". Must match /^ws_[a-z0-9_]{1,64}$/i.`,
    );
  }
}

/** Absolute path to the credentials directory for a workspace. */
function credentialsDir(wsId: string, workDir: string): string {
  return join(workDir, "workspaces", wsId, "credentials");
}

/** Absolute path to the credential file for a bundle in a workspace. */
export function credentialPath(wsId: string, bundleName: string, workDir: string): string {
  assertValidWsId(wsId);
  return join(credentialsDir(wsId, workDir), `${bundleSlug(bundleName)}.json`);
}

// ── Atomic write + per-file lock helpers ─────────────────────────

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

/**
 * In-process serialization for read-modify-write operations on the same
 * credential file. Two concurrent `saveWorkspaceCredential` or
 * `clearWorkspaceCredential` calls with different keys on the same
 * `{wsId, bundleName}` would otherwise both read the old state and the
 * second write would overwrite the first — silently losing a key. Atomic
 * rename guarantees "no partial file observable," not "no lost updates."
 *
 * The fix is a promise chain per file path: each operation waits for the
 * previous one on the same file to settle, then runs, then extends the
 * chain. Since NimbleBrain runs as a single process, in-process serialization
 * is sufficient — we don't need flock / O_EXCL semantics across processes.
 */
const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(path) ?? Promise.resolve();
  // A prior failure on the same path must not poison subsequent operations —
  // hence the `.catch(() => {})` rather than letting a rejection propagate
  // into the new chain link.
  const current = previous.catch(() => {}).then(fn);
  fileLocks.set(path, current);
  try {
    return await current;
  } finally {
    // Clean up only if nobody chained onto us — otherwise the next caller
    // still needs to see our promise as the tail.
    if (fileLocks.get(path) === current) {
      fileLocks.delete(path);
    }
  }
}

/**
 * Write `content` to `path` atomically with the requested mode.
 * Writes to `{path}.tmp.{timestamp}.{counter}` then renames into place so
 * readers never observe a partial file. This function alone is not
 * sufficient for read-modify-write callers — see `withFileLock` above.
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
 *
 * Parent directory invariant: this primitive assumes `workspaces/{wsId}/`
 * already exists with `0o700`. In production that holds because
 * `WorkspaceStore.create` runs first and creates it explicitly. If a test
 * writes a credential without first creating the workspace, the intermediate
 * directory will get umask-default mode (typically `0o755`) — the leaf stays
 * `0o700` because we `chmod` it below, but the parent doesn't. Keep this
 * coupling in mind if the call order ever changes.
 */
async function ensureCredentialsDir(wsId: string, workDir: string): Promise<string> {
  const dir = credentialsDir(wsId, workDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `mkdir({ mode })` only applies to newly created directories; harden the
  // final leaf regardless (cheap no-op when already correct).
  try {
    await chmod(dir, 0o700);
  } catch (err) {
    // Don't abort — the file write still applies `0o600` explicitly, so a
    // writable file under a permissive directory leaks the *fact* of which
    // bundles have credentials (directory listing), but not the contents.
    // Surface a warning so an operator can investigate ownership/mode.
    console.warn(
      `[workspace-credentials] chmod 0700 failed on ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }. Credential file contents remain protected via 0600, but the ` +
        `directory listing may be readable. Check ownership.`,
    );
  }
  return dir;
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Read and parse the credential file for `bundleName` in workspace `wsId`.
 *
 * Returns `null` if the file does not exist (not an error — missing creds are
 * normal; the caller falls through to the next tier). If the file exists but
 * has a mode other than `0o600`, a warning is written to stderr.
 *
 * The permission check is advisory: we've already read the file by the time
 * we stat it, so refusing on a mode mismatch wouldn't prevent credential
 * disclosure to *us*. The check exists to nudge operators toward fixing the
 * permissions before the file leaks via backup/sync/other readers. Refusing
 * would also cause hard failures on legitimate upgrades where an older file
 * predates the explicit-chmod write path.
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

  // Advisory permission check — see function docblock. Only the 9 mode bits
  // are relevant; higher bits (setuid/setgid/sticky) and file-type bits
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
 *
 * The read-modify-write sequence is serialized per-file via `withFileLock`
 * so two concurrent saves on the same `{wsId, bundleName}` can't silently
 * drop either update's key.
 */
export async function saveWorkspaceCredential(
  wsId: string,
  bundleName: string,
  key: string,
  value: string,
  workDir: string,
): Promise<void> {
  const filePath = credentialPath(wsId, bundleName, workDir);
  await withFileLock(filePath, async () => {
    await ensureCredentialsDir(wsId, workDir);
    const existing = (await getWorkspaceCredentials(wsId, bundleName, workDir)) ?? {};
    const merged: Record<string, string> = { ...existing, [key]: value };
    await atomicWriteFile(filePath, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
  });
}

/**
 * Remove a single credential key for `bundleName` in workspace `wsId`.
 *
 * Returns `true` if the key was present (and was removed), `false` otherwise.
 * If removing the key leaves the file empty, the file is deleted.
 *
 * Read-modify-write is serialized per-file (same lock as `saveWorkspaceCredential`)
 * to prevent a concurrent save from being lost when this function rewrites
 * the trimmed map.
 */
export async function clearWorkspaceCredential(
  wsId: string,
  bundleName: string,
  key: string,
  workDir: string,
): Promise<boolean> {
  const filePath = credentialPath(wsId, bundleName, workDir);
  return withFileLock(filePath, async () => {
    const existing = await getWorkspaceCredentials(wsId, bundleName, workDir);
    if (!existing || !(key in existing)) return false;

    const { [key]: _removed, ...rest } = existing;

    if (Object.keys(rest).length === 0) {
      await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
      return true;
    }

    await atomicWriteFile(filePath, `${JSON.stringify(rest, null, 2)}\n`, 0o600);
    return true;
  });
}

/**
 * Remove the entire credential file for `bundleName` in workspace `wsId`.
 * Returns `true` if the file existed (and was removed), `false` otherwise.
 *
 * Serialized against concurrent save/clear operations on the same file so
 * an in-flight write can't race with the unlink (unlink-after-rename on
 * the same path would otherwise non-deterministically either remove the
 * new file or fail with ENOENT).
 */
export async function clearAllWorkspaceCredentials(
  wsId: string,
  bundleName: string,
  workDir: string,
): Promise<boolean> {
  const filePath = credentialPath(wsId, bundleName, workDir);
  return withFileLock(filePath, async () => {
    try {
      await unlink(filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

// ── Tier resolver ─────────────────────────────────────────────────

/** Field descriptor from a bundle's `user_config` manifest section. */
export interface UserConfigFieldDef {
  type: string;
  title?: string;
  description?: string;
  sensitive?: boolean;
  required?: boolean;
  default?: unknown;
}

/** Options for `resolveUserConfig`. */
export interface ResolveUserConfigOpts {
  /** The bundle's canonical name (e.g. `@nimblebraininc/newsapi`). */
  bundleName: string;
  /**
   * The bundle manifest's `user_config` schema, keyed by field name.
   * `null` or `undefined` means the bundle requires no user config — the
   * resolver returns `{}` immediately.
   */
  userConfigSchema: Record<string, UserConfigFieldDef> | null | undefined;
  /** Workspace id. Required — everything is workspace-scoped. */
  wsId: string;
  /** Root work directory (e.g. `~/.nimblebrain`). */
  workDir: string;
  /** Interactive gate used to prompt for values (TUI `configure` flow only). */
  gate?: ConfirmationGate;
  /**
   * If `true`, prompt for every field via the gate and persist responses to
   * the workspace store. Used by the `nb__manage_app configure` TUI action.
   * No effect when `gate?.supportsInteraction` is false.
   */
  forcePrompt?: boolean;
}

/**
 * Resolve `user_config` field values for a bundle from the workspace
 * credential store.
 *
 * This is the host-side half of a two-stage resolution. It returns a
 * **partial** map of whatever it found (or prompted for); the mpak SDK
 * then tries its own tiers — manifest-declared `mcp_config.env` aliases
 * and manifest defaults — and throws `MpakConfigError` if anything
 * required is still unresolved. Callers catch that at the SDK boundary
 * and translate to a `nb config set -w <wsId>` hint.
 *
 * Behavior:
 *
 *   - Default mode: read each field from `getWorkspaceCredentials`.
 *     Include any non-empty string values in the result. Absent/empty
 *     values fall through silently — the SDK decides whether that's an
 *     error based on `required` and its own tiers.
 *
 *   - `forcePrompt` + interactive gate: used by the TUI configure flow.
 *     Prompt every field via `gate.promptConfigValue`. Persist each
 *     returned value to the workspace store. Skipped responses are
 *     omitted — the SDK's missing-required check fires if appropriate.
 *
 * `null`/`undefined`/empty `userConfigSchema` short-circuits to `{}`.
 *
 * `~/.mpak/config.json` is intentionally not consulted here or anywhere
 * else in NimbleBrain — the workspace store is our persistence surface.
 */
export async function resolveUserConfig(
  opts: ResolveUserConfigOpts,
): Promise<Record<string, string>> {
  const { bundleName, userConfigSchema, wsId, workDir, gate, forcePrompt } = opts;

  if (!userConfigSchema) return {};
  const fieldNames = Object.keys(userConfigSchema);
  if (fieldNames.length === 0) return {};

  const interactive = gate?.supportsInteraction === true;

  // TUI configure flow: prompt every field, persist, return whatever the
  // user provided. Skipped prompts don't get persisted and don't end up in
  // the result — the SDK's required-field check catches that downstream.
  if (forcePrompt && interactive && gate) {
    const resolved: Record<string, string> = {};
    for (const key of fieldNames) {
      const field = userConfigSchema[key];
      if (!field) continue;
      const prompted = await gate.promptConfigValue({
        key,
        title: field.title,
        description: field.description,
        sensitive: field.sensitive,
        required: field.required,
      });
      if (typeof prompted === "string" && prompted.length > 0) {
        await saveWorkspaceCredential(wsId, bundleName, key, prompted, workDir);
        resolved[key] = prompted;
      }
    }
    return resolved;
  }

  // Default: read workspace store, return non-empty string values. The SDK
  // handles mcp_config.env aliases, manifest defaults, and required-field
  // validation from here. See `mpak-sdk`'s `gatherUserConfig` for the rest
  // of the resolution chain.
  const stored = (await getWorkspaceCredentials(wsId, bundleName, workDir)) ?? {};
  const resolved: Record<string, string> = {};
  for (const key of fieldNames) {
    const v = stored[key];
    if (typeof v === "string" && v.length > 0) resolved[key] = v;
  }
  return resolved;
}

/**
 * Translate an `MpakConfigError` from the mpak SDK into NimbleBrain's
 * copy-pastable `nb config set -w <wsId>` hint. Callers use this at every
 * site that calls `mpak.prepareServer` after host-side credential resolution.
 *
 * Each missing field's message includes the specific env var(s) the
 * bundle declared as satisfying it in `mcp_config.env` — read directly
 * from `MpakConfigError.missingFields[i].envAliases` (0.5.0+). Users
 * see the actual export line they can run, not a pointer at a file they
 * may not know how to inspect.
 *
 * Returns the input error unchanged when it is not a credential-missing
 * error, so `catch` blocks can forward non-credential failures untouched.
 */
export function friendlyMpakConfigError(err: unknown, wsId: string): Error {
  if (!(err instanceof MpakConfigError)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const bundle = err.packageName;
  const fields = err.missingFields;
  if (fields.length === 0) return new Error(err.message);

  // Per-field hint: one `nb config set` line, plus one `export VAR=...`
  // line per declared env alias. The alias list is derived by the SDK
  // and attached to each missing field — we don't re-derive it.
  const hintLines: string[] = [];
  for (const f of fields) {
    hintLines.push(`  nb config set ${bundle} ${f.key}=<value> -w ${wsId}`);
    for (const envVar of f.envAliases) {
      hintLines.push(`  export ${envVar}=<value>  # satisfies "${f.key}"`);
    }
  }

  // MpakConfigError types `title` as required string, but an empty value
  // is useless for user-facing output — fall back to the raw key.
  const labels = fields.map((f) => `"${f.title?.length ? f.title : f.key}"`).join(", ");
  return new Error(
    `Missing required config ${labels} for ${bundle}.\nRun one of:\n${hintLines.join("\n")}`,
  );
}
