import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import { isDisallowed, type PermissionOwner, type PermissionStore } from "./permission-store.ts";

/**
 * The single connector-permission check. Returns the denied `ToolResult` (the
 * structured `tool_permission_denied` envelope) when the `owner` has set the
 * tool's policy to `disallow`, otherwise `null` (allow).
 *
 * Every door that dispatches a tool call — the chat engine
 * (`IdentityToolRouter`), the external `/mcp` server, and the REST registry —
 * runs this BEFORE `source.execute`, so a `disallow` is honored uniformly
 * rather than only on the door that happens to route through
 * `ToolRegistry.execute`. `owner` is the policy principal: `{scope:"workspace"}`
 * for a workspace tool, `{scope:"user"}` for an identity-owned personal
 * connector (its owner's policy, the same one the workspace door consults at
 * home). `serverName` is the connector/source prefix; `toolName` is the bare
 * local tool (no source prefix).
 */
export async function assertToolAllowed(
  permissionStore: PermissionStore,
  owner: PermissionOwner,
  serverName: string,
  toolName: string,
): Promise<ToolResult | null> {
  const policy = await permissionStore.get(owner, serverName, toolName);
  if (!isDisallowed(policy)) return null;
  return {
    content: textContent(
      `Tool "${serverName}__${toolName}" is disabled by policy. Adjust in Settings → Connectors → ${serverName} → Configure.`,
    ),
    isError: true,
    structuredContent: {
      error: "tool_permission_denied",
      connector: serverName,
      tool: toolName,
      scope: owner.scope,
    },
  };
}
