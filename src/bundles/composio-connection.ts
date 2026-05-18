/**
 * Composio connected-account state for a workspace.
 *
 * NimbleBrain integrates with Composio as a remote OAuth provider for
 * toolkits (Gmail, Slack, HubSpot, …) where we do not yet hold the
 * vendor's own restricted-scope approval. Composio holds the user's
 * vendor tokens; the platform only holds an opaque `connectedAccountId`
 * pointer per workspace per connector.
 *
 * Storage layout (mirrors `oauth-tokens.ts` workspaceOAuthDir):
 *   <workDir>/workspaces/<wsId>/credentials/composio/<connectorId>/connection.json
 *
 * The file is the gating signal for a Composio-backed connector: if
 * present and `status === "ACTIVE"`, the platform may resolve its
 * remote-MCP URL with `user_id={NB_USER_ID}` and start the source. If
 * absent, the connector stays in `not_authenticated` until
 * `/v1/composio-auth/callback` writes it.
 *
 * Security posture mirrors workspace-credentials.ts: 0o700 directory,
 * 0o600 file, atomic temp+rename writes, wsId validated against
 * WORKSPACE_ID_RE before any path is built.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceContext } from "../workspace/context.ts";
import { WORKSPACE_ID_RE } from "../workspace/workspace-store.ts";

/**
 * Persisted state for one (workspace, connector) Composio connection.
 *
 * Kept deliberately minimal: anything beyond the pointer + status lives
 * on Composio's side. `userId` is the value the platform passed to
 * `connected_accounts.initiate(user_id=…)` — recorded so a future audit
 * can prove which Composio namespace this connection sits in.
 */
export interface ComposioConnection {
  /** Composio's identifier for the connected account (e.g. `ca_…`). */
  connectedAccountId: string;
  /** Toolkit slug at Composio (e.g. `gmail`). */
  toolkit: string;
  /** The `user_id` value passed to Composio at initiate time. */
  userId: string;
  /** ISO-8601 timestamp the connection landed. */
  connectedAt: string;
  /**
   * Composio's reported status at callback time. Composio's lifecycle
   * may move this independently of NimbleBrain (revocation, vendor
   * disconnect, etc.), so callers should treat absent or stale values
   * as "verify with Composio before acting." The string isn't
   * normalized — we record whatever Composio returns and let the
   * connector layer decide what's actionable.
   */
  status: string;
}

/**
 * Slug rule for `connectorId` segment of the path.
 *
 * Catalog entries name connectors with reverse-DNS dots and slashes
 * (`com.google/gmail`). Those translate into filesystem-unsafe path
 * components; we slug to `[A-Za-z0-9._-]+` matching the same pattern
 * used by `bundleSlug` in workspace-credentials.ts. Validation is
 * tight: anything that would escape the connector directory or shell
 * out throws. Better to fail loud than to silently write to an
 * unexpected path.
 */
const CONNECTOR_ID_RE = /^[A-Za-z0-9._-]+$/;
export function connectorSlug(connectorId: string): string {
  if (typeof connectorId !== "string" || connectorId.length === 0) {
    throw new Error(`[composio-connection] invalid connectorId: must be a non-empty string`);
  }
  const slug = connectorId.replace(/^@/, "").replace(/[/\\]/g, "-");
  if (!CONNECTOR_ID_RE.test(slug) || slug === "." || slug === "..") {
    throw new Error(
      `[composio-connection] invalid connectorId "${connectorId}": ` +
        `must contain only alphanumerics, dot, underscore, hyphen, and one optional @scope/ prefix`,
    );
  }
  return slug;
}

function assertValidWsId(wsId: string): void {
  if (typeof wsId !== "string" || !WORKSPACE_ID_RE.test(wsId)) {
    throw new Error(
      `[composio-connection] invalid wsId: "${wsId}". Must match /^ws_[a-z0-9_]{1,64}$/i.`,
    );
  }
}

/** Absolute path to the per-connector composio credentials directory. */
export function composioConnectorDir(workDir: string, wsId: string, connectorId: string): string {
  assertValidWsId(wsId);
  // Routed through WorkspaceContext so the `workspaces/{wsId}/credentials/`
  // layout has exactly one definition site (see src/workspace/context.ts).
  // `assertValidWsId` above stays for back-compat — the context constructor
  // validates again, which is cheap and gives a consistent error message
  // shape for either failure mode.
  return new WorkspaceContext({ wsId, workDir }).getDataPath(
    "credentials",
    "composio",
    connectorSlug(connectorId),
  );
}

/** Absolute path to `connection.json` for a (workspace, connector). */
export function composioConnectionPath(workDir: string, wsId: string, connectorId: string): string {
  return join(composioConnectorDir(workDir, wsId, connectorId), "connection.json");
}

/**
 * True iff a `connection.json` exists at the expected path for this
 * (workspace, connector). Existence-only — does not parse or validate.
 * Used at platform boot to pick the right initial state for a Composio-
 * backed connector (`not_authenticated` vs ready-to-start).
 */
export function hasPersistedComposioConnection(
  workDir: string,
  wsId: string,
  connectorId: string,
): boolean {
  return existsSync(composioConnectionPath(workDir, wsId, connectorId));
}

let tmpCounter = 0;
function uniqueTmpSuffix(): string {
  return `${Date.now()}.${++tmpCounter}`;
}

async function atomicWriteFile(path: string, content: string, mode: number): Promise<void> {
  const tmpPath = `${path}.tmp.${uniqueTmpSuffix()}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await chmod(tmpPath, mode);
  await rename(tmpPath, path);
}

/**
 * Write `connection.json` atomically with 0o600. Parent dirs created
 * with 0o700. Replaces any existing file at the path — Composio
 * connections are owned by the most recent successful flow; the
 * previous `connectedAccountId` becomes orphaned at Composio (must be
 * cleaned up there, not here).
 */
export async function saveComposioConnection(
  workDir: string,
  wsId: string,
  connectorId: string,
  connection: ComposioConnection,
): Promise<void> {
  const dir = composioConnectorDir(workDir, wsId, connectorId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // Best-effort directory hardening — the file is 0o600 explicitly.
    // Mirror workspace-credentials.ts's policy of not aborting here.
  }
  const filePath = composioConnectionPath(workDir, wsId, connectorId);
  await atomicWriteFile(filePath, `${JSON.stringify(connection, null, 2)}\n`, 0o600);
}

/**
 * Read and parse `connection.json`. Returns `null` if the file does
 * not exist — missing is a normal state (connector not yet
 * authenticated). Throws on parse error or missing required fields so
 * a corrupted file surfaces loudly rather than silently masquerading
 * as "not connected."
 */
export async function readComposioConnection(
  workDir: string,
  wsId: string,
  connectorId: string,
): Promise<ComposioConnection | null> {
  const filePath = composioConnectionPath(workDir, wsId, connectorId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[composio-connection] failed to parse ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`[composio-connection] ${filePath} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  for (const k of ["connectedAccountId", "toolkit", "userId", "connectedAt", "status"]) {
    if (typeof obj[k] !== "string" || (obj[k] as string).length === 0) {
      throw new Error(`[composio-connection] ${filePath} missing required field "${k}"`);
    }
  }
  return {
    connectedAccountId: obj.connectedAccountId as string,
    toolkit: obj.toolkit as string,
    userId: obj.userId as string,
    connectedAt: obj.connectedAt as string,
    status: obj.status as string,
  };
}

/**
 * Delete `connection.json` for a (workspace, connector). Returns
 * `true` if the file existed and was removed, `false` if it didn't.
 *
 * Called from `lifecycle.disconnect` for Composio-backed bundles —
 * the parallel of `revokeAndDeleteTokens` on the OAuth provider for
 * native bundles. Composio-side account deletion is handled
 * separately (in `composio-auth.ts`) so this module stays SDK-free.
 */
export async function deleteComposioConnection(
  workDir: string,
  wsId: string,
  connectorId: string,
): Promise<boolean> {
  const filePath = composioConnectionPath(workDir, wsId, connectorId);
  try {
    await unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
