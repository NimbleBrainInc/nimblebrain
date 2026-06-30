import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { PermissionStore } from "./permission-store.ts";

/**
 * The single workspace connector-permission check. Returns the denied
 * `ToolResult` (the structured `tool_permission_denied` envelope) when the
 * workspace has set the tool's policy to `disallow`, otherwise `null` (allow).
 *
 * Every door that dispatches a WORKSPACE-scoped tool call — the chat engine
 * (`IdentityToolRouter`), the external `/mcp` server, and the REST registry —
 * runs this BEFORE `source.execute`, so an operator's `disallow` is honored
 * uniformly rather than only on the door that happens to route through
 * `ToolRegistry.execute`. `serverName` is the connector/source prefix;
 * `toolName` is the bare local tool (no source prefix).
 */
export async function assertToolAllowed(
  permissionStore: PermissionStore,
  wsId: string,
  serverName: string,
  toolName: string,
): Promise<ToolResult | null> {
  const owner = { scope: "workspace" as const, wsId };
  const policy = await permissionStore.get(owner, serverName, toolName);
  if (policy !== "disallow") return null;
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
