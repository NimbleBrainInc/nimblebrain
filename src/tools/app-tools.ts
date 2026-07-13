import { getMpak } from "../bundles/mpak.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { InProcessTool } from "./in-process-app.ts";

/**
 * Context for the org-scoped `manage_apps` tool. Identity-bound (no workspace
 * context) — app version management is org-global.
 */
export interface ManageAppsContext {
  runtime: Runtime;
  getIdentity: () => UserIdentity | null;
}

function errResult(msg: string): ToolResult {
  return { content: textContent(msg), isError: true };
}

function permissionDenied(): ToolResult {
  return {
    content: textContent("You don't have permission to manage apps. Ask an org admin."),
    structuredContent: { error: "permission_denied" },
    isError: true,
  };
}

/**
 * `manage_apps` — org-admin management of installed registry "apps" (mpak
 * bundles).
 *
 * Why org-scoped (not per-workspace like `manage_connectors`): the mpak cache
 * is keyed by bundle NAME only (no version) and shared platform-wide, so an
 * app's *version* is global — one force-pull changes the artifact every
 * workspace gets. Upgrading therefore re-spawns the app in every workspace
 * that has it, keeping the running version consistent. Installing / connecting
 * / authing an app into a specific workspace stays on `manage_connectors`
 * (ws_admin); version management lives here (org_admin).
 *
 * Actions:
 *   - `list`          — every distinct registry app installed across the org,
 *                       deduped by bundle name (version is shared), with the
 *                       workspaces using it.
 *   - `check_updates` — which of those have a newer version on the registry.
 *   - `upgrade`       — force-pull latest + re-spawn that app in all workspaces.
 */
export function createManageAppsTool(ctx: ManageAppsContext): InProcessTool {
  return {
    name: "manage_apps",
    description:
      "Org-admin management of installed registry apps (mpak bundles): list them across the org, check for updates, and upgrade an app to the latest version everywhere it's installed. App version is org-global (shared cache); per-workspace install/connect lives in manage_connectors.",
    annotations: { "ai.nimblebrain/internal": true },
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "check_updates", "upgrade"],
          description: "Action to perform.",
        },
        bundleName: {
          type: "string",
          description: "Scoped app/bundle name, e.g. @scope/name (required for `upgrade`).",
        },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      // Org-admin gate on every action — version management spans the whole org.
      const identity = ctx.getIdentity();
      if (!identity || !ORG_ADMIN_ROLES.has(identity.orgRole)) {
        return permissionDenied();
      }
      const action = String(input.action ?? "");
      switch (action) {
        case "list":
          return handleList(ctx);
        case "check_updates":
          return handleCheckUpdates(ctx);
        case "upgrade":
          return handleUpgrade(ctx, String(input.bundleName ?? ""));
        default:
          return errResult(`Unknown action "${action}".`);
      }
    },
  };
}

/** One row in the org apps list — one per distinct registry bundle name. */
interface OrgApp {
  bundleName: string;
  version: string;
  trustScore: number | null;
  workspaceCount: number;
  workspaceIds: string[];
}

/**
 * Aggregate registry instances across all workspaces, deduped by `bundleName`
 * (the version is shared platform-wide, so one row per app). Local dev copies
 * and remote URL/Composio connectors are excluded — they have no mpak version.
 */
function aggregateRegistryApps(ctx: ManageAppsContext): OrgApp[] {
  const byName = new Map<string, OrgApp>();
  for (const inst of ctx.runtime.getLifecycle().getInstances()) {
    if (inst.installSource !== "registry") continue;
    const existing = byName.get(inst.bundleName);
    if (existing) {
      existing.workspaceCount += 1;
      existing.workspaceIds.push(inst.wsId);
    } else {
      byName.set(inst.bundleName, {
        bundleName: inst.bundleName,
        version: inst.version,
        trustScore: inst.trustScore,
        workspaceCount: 1,
        workspaceIds: [inst.wsId],
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.bundleName.localeCompare(b.bundleName));
}

function handleList(ctx: ManageAppsContext): ToolResult {
  const apps = aggregateRegistryApps(ctx);
  const summary =
    apps.length === 0
      ? "No registry apps installed in this org."
      : `${apps.length} app(s): ${apps.map((a) => `${a.bundleName}@${a.version}`).join(", ")}.`;
  return { content: textContent(summary), structuredContent: { apps }, isError: false };
}

async function handleCheckUpdates(ctx: ManageAppsContext): Promise<ToolResult> {
  const apps = aggregateRegistryApps(ctx);
  if (apps.length === 0) {
    return {
      content: textContent("No registry apps installed — nothing to check."),
      structuredContent: { updates: [] },
      isError: false,
    };
  }
  const mpak = getMpak(ctx.runtime.getMpakHome());
  const updates: Array<{ bundleName: string; current: string; latest: string }> = [];
  await Promise.all(
    apps.map(async (app) => {
      try {
        const latest = await mpak.bundleCache.checkForUpdate(app.bundleName, { force: true });
        if (latest && latest !== app.version) {
          updates.push({ bundleName: app.bundleName, current: app.version, latest });
        }
      } catch {
        // Skip apps that fail to check (delisted, registry hiccup).
      }
    }),
  );
  updates.sort((a, b) => a.bundleName.localeCompare(b.bundleName));
  const summary =
    updates.length === 0
      ? "All apps are up to date."
      : `${updates.length} update(s) available: ${updates.map((u) => `${u.bundleName} ${u.current}→${u.latest}`).join(", ")}.`;
  return { content: textContent(summary), structuredContent: { updates }, isError: false };
}

async function handleUpgrade(ctx: ManageAppsContext, bundleName: string): Promise<ToolResult> {
  if (!bundleName) return errResult("bundleName is required for upgrade.");
  try {
    const result = await ctx.runtime
      .getLifecycle()
      .upgradeApp(bundleName, (wsId) => ctx.runtime.getRegistryForWorkspace(wsId));
    const upgraded = result.from !== result.to;
    const okCount = result.workspaces.filter((w) => w.ok).length;
    const failed = result.workspaces.filter((w) => !w.ok);
    let msg: string;
    if (!upgraded) {
      msg = `"${bundleName}" is already at the latest version (${result.from}).`;
    } else {
      msg = `Upgraded "${bundleName}": ${result.from} → ${result.to} across ${okCount} workspace(s)`;
      msg += failed.length > 0 ? `; ${failed.length} failed.` : ".";
    }
    return {
      content: textContent(msg),
      structuredContent: { ok: failed.length === 0, upgraded, ...result },
      isError: false,
    };
  } catch (err) {
    return errResult(
      `Failed to upgrade "${bundleName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
