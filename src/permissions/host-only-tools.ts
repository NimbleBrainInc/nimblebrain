import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import { LIFECYCLE_EVENTS, type LifecycleDeclaration } from "../lifecycle/types.ts";

/**
 * Connector tools only the host may call: the handlers a connector's
 * `lifecycle` block names (`on_ready`, `on_removing`).
 *
 * A lifecycle event means the host did something: it installed the connector,
 * or it is about to remove it. A handler anyone else can call lets them forge
 * that fact, so a declared handler is offered to no one. It is absent from
 * every listing and refused on every door, for every principal, admins
 * included. The host's own calls (`src/lifecycle/notify.ts`) reach the source
 * through `connectorPortForSource` and pass no door, so they are unaffected.
 *
 * The declaration is read from the operator-trusted catalog entry and never
 * from anything the running server sends, as `admin_tools` is. The scope
 * matches `admin_tools` too: workspace connectors only. A personal connector
 * acts on its owner's own account, has no catalog `lifecycle` block, and is
 * never called by the host's lifecycle notifications.
 */

/** Whether `lifecycle` names `toolName` as a handler, so only the host may call it. */
export function isHostOnlyTool(
  lifecycle: LifecycleDeclaration | undefined,
  toolName: string,
): boolean {
  if (lifecycle === undefined) return false;
  return LIFECYCLE_EVENTS.some((event) => lifecycle[event] === toolName);
}

/**
 * The refusal every door returns, in the envelope `assertToolAllowed` uses.
 *
 * It says who calls the tool and names no other route to it, because there is
 * none and a model reading it should not go looking.
 */
export function hostOnlyToolDenial(serverName: string, toolName: string): ToolResult {
  return {
    content: textContent(
      `"${serverName}__${toolName}" is called by the host when the connector is installed or removed. It cannot be called directly.`,
    ),
    isError: true,
    structuredContent: {
      error: "host_only_tool",
      connector: serverName,
      tool: toolName,
    },
  };
}
