import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

// ── Tier resolver ─────────────────────────────────────────────────

/**
 * Strip a trailing `inc` (case-insensitive) from a scope segment.
 *
 * Rationale: the GitHub org `nimblebraininc` exists only because `nimblebrain`
 * was taken on GitHub. The brand — and therefore the env var convention — is
 * `nimblebrain`. Stripping the suffix keeps the env var name aligned with the
 * public brand instead of a GitHub artifact.
 */
function normalizeScope(scope: string): string {
  return scope.replace(/inc$/i, "");
}

/**
 * Compute the process environment variable name for a bundle field.
 *
 * Convention: `NB_CONFIG_{SCOPE}_{NAME}_{FIELD}` — uppercase, with hyphens
 * replaced by underscores. The scope segment is included to prevent collisions
 * between same-named bundles from different scopes.
 *
 * Scope normalization: a trailing `inc` on the scope is stripped (see
 * `normalizeScope`). If the scope collapses to an empty string (e.g. a bare
 * `@inc/foo`), the env var falls back to the unscoped form.
 *
 * Examples:
 *   `@nimblebraininc/newsapi` + `api_key` → `NB_CONFIG_NIMBLEBRAIN_NEWSAPI_API_KEY`
 *   `@foo/bar`                + `field`   → `NB_CONFIG_FOO_BAR_FIELD`
 *   `bundleName`              + `field`   → `NB_CONFIG_BUNDLENAME_FIELD`
 *   `my-bundle`               + `api-key` → `NB_CONFIG_MY_BUNDLE_API_KEY`
 */
export function envVarName(bundleName: string, fieldName: string): string {
  const normalize = (s: string): string => s.replace(/-/g, "_").toUpperCase();

  // Strip leading `@` and split into [scope, name] if scoped.
  const stripped = bundleName.replace(/^@/, "");
  const slashIdx = stripped.indexOf("/");

  const fieldPart = normalize(fieldName);

  if (slashIdx === -1) {
    // Unscoped: NB_CONFIG_{NAME}_{FIELD}
    return `NB_CONFIG_${normalize(stripped)}_${fieldPart}`;
  }

  const rawScope = stripped.slice(0, slashIdx);
  const name = stripped.slice(slashIdx + 1);
  const scope = normalizeScope(rawScope);

  // Edge case: scope normalizes to empty (e.g. bare `inc`) — fall back to
  // unscoped form rather than emitting a double-underscore.
  if (scope === "") {
    return `NB_CONFIG_${normalize(name)}_${fieldPart}`;
  }

  return `NB_CONFIG_${normalize(scope)}_${normalize(name)}_${fieldPart}`;
}

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
  /** Interactive gate used to prompt for missing values (TUI-only). */
  gate?: ConfirmationGate;
  /**
   * If `true`, prompt for every field even when a stored value exists.
   * No effect when `gate?.supportsInteraction` is false.
   */
  forcePrompt?: boolean;
}

/**
 * Resolve all `user_config` field values for a bundle in a workspace.
 *
 * Resolution hierarchy (first match wins, per field):
 *   1. Workspace credential store — `getWorkspaceCredentials(wsId, bundleName, workDir)`
 *   2. Process environment        — `process.env[envVarName(bundleName, field)]`
 *   3. Manifest default           — `field.default`
 *
 * `~/.mpak/config.json` is intentionally NOT consulted. NimbleBrain neither
 * reads nor writes the global mpak config; users with values there must re-set
 * them via `nb config set -w <wsId>`.
 *
 * If a field is still missing after all tiers:
 *   - If `gate?.supportsInteraction` is true, prompt via
 *     `gate.promptConfigValue(...)`. A returned value is persisted to the
 *     workspace credential store (tier 1) and included in the result.
 *   - Else if `field.required !== false` (required or unspecified), throw a
 *     descriptive error with a copy-pastable `nb config set -w <wsId>` hint.
 *   - Otherwise (optional), the field is silently omitted from the result.
 *
 * When `forcePrompt` is true AND the gate supports interaction, the resolver
 * skips steps 1–3 entirely and prompts for every field. This is how
 * `nb config set` re-prompts are implemented.
 *
 * `null`/`undefined`/empty `userConfigSchema` short-circuits to `{}`.
 *
 * The returned map contains only resolved values as strings — callers pass it
 * directly to the mpak SDK's `prepareServer({ userConfig })` option.
 */
export async function resolveUserConfig(
  opts: ResolveUserConfigOpts,
): Promise<Record<string, string>> {
  const { bundleName, userConfigSchema, wsId, workDir, gate, forcePrompt } = opts;

  if (!userConfigSchema) return {};
  const fieldNames = Object.keys(userConfigSchema);
  if (fieldNames.length === 0) return {};

  // Tier 1 is read once per bundle (it's a single file).
  const stored = (await getWorkspaceCredentials(wsId, bundleName, workDir)) ?? {};

  const interactive = gate?.supportsInteraction === true;
  const resolved: Record<string, string> = {};

  for (const key of fieldNames) {
    const field = userConfigSchema[key];
    if (!field) continue;

    let value: string | undefined;

    if (forcePrompt && interactive) {
      // Skip tiers 1–3; go straight to prompt.
    } else {
      // Tier 1: workspace credential store.
      const storedValue = stored[key];
      if (typeof storedValue === "string" && storedValue.length > 0) {
        value = storedValue;
      }

      // Tier 2: process environment.
      if (value === undefined) {
        const envValue = process.env[envVarName(bundleName, key)];
        if (typeof envValue === "string" && envValue.length > 0) {
          value = envValue;
        }
      }

      // Tier 3: manifest default.
      // MCPB manifests restrict user_config types to primitives (string, number,
      // boolean, directory, file), so String() is safe. An object/array default
      // would stringify to "[object Object]" or a comma-joined form — if that
      // ever happens it reflects a malformed manifest upstream, not a bug here.
      if (value === undefined && field.default !== undefined && field.default !== null) {
        value = String(field.default);
      }
    }

    if (value !== undefined) {
      resolved[key] = value;
      continue;
    }

    // Still missing. Try interactive prompt if available.
    if (interactive && gate) {
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
        continue;
      }
    }

    // No value, no prompt (or prompt returned nothing).
    const isRequired = field.required !== false;
    if (isRequired) {
      const label = field.title ?? key;
      // Never include values or defaults in the error — only field names.
      throw new Error(
        `Missing required config "${label}" for ${bundleName}.\n` +
          `Run: nb config set ${bundleName} ${key}=<value> -w ${wsId}`,
      );
    }
    // Optional field with no value — skip.
  }

  return resolved;
}
