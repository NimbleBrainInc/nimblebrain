/**
 * Map orchestrator errors to engine-shaped `ToolResult`s.
 *
 * `routeToolCall` throws a small, deliberate set of classes (see `./route.ts`).
 * Tool routers that compose `routeToolCall` and surface results to the engine
 * need to render those throws as `isError: true` results — the engine treats
 * thrown errors as run-level failures (`run.error`), not per-call failures,
 * which is the wrong shape for "you called a tool name we couldn't route."
 *
 * Distinct `data.reason` values so HTTP / `/mcp` consumers can differentiate
 * failure modes without parsing the human message:
 *
 *   - `UnknownNamespacedToolName` → `invalid_tool_name`        + `{ name, parseReason }`
 *   - `WorkspaceAccessDenied`     → `workspace_access_denied`  + `{ identityId, wsId }`
 *     (the live base of `WorkspaceToolUnavailable`)
 *   - `UnknownToolSource`         → `unknown_tool_source`      + `{ wsId, sourceName, toolName }`
 *   - `UnknownIdentitySource`     → `unknown_identity_source`  + `{ toolName }`
 *   - `ConnectorGrantDenied`      → `connector_grant_denied`   + `{ connector, wsId }`
 *
 * Non-orchestrator errors re-throw — those are real engine failures and
 * should hit the engine's `run.error` path. We deliberately do NOT
 * `?? "unknown"` here: an unrecognized class is a programmer error worth
 * surfacing as a thrown engine error rather than masking as a tool error.
 */

import type { ToolResult } from "../engine/types.ts";
import {
  ConnectorGrantDenied,
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  WorkspaceAccessDenied,
} from "./route.ts";

export function mapOrchestratorErrorToToolResult(err: unknown, namespacedName: string): ToolResult {
  if (err instanceof UnknownNamespacedToolName) {
    // The retired-form error already carries its own remedy — "re-list tools and
    // call <bare name>" — so it is emitted alone. Wrapping it in the generic
    // advice below would append "use a fully namespaced tool name", the exact
    // opposite instruction, and a model reading the trailing clause re-emits the
    // namespaced form and loops. This is the rollout hot path: a conversation
    // resumed across the upgrade has prefixed names in history and bare names in
    // its tool list, so it WILL produce legacy names.
    const text =
      err.reason === "legacy_namespaced_form"
        ? err.message
        : `[orchestrator] invalid tool name "${err.input}": ${err.message} (no fallback to current workspace — use a bare <source>__<tool> name).`;
    return {
      content: [{ type: "text", text }],
      isError: true,
      structuredContent: {
        error: "orchestrator_error",
        reason: "invalid_tool_name",
        name: err.input,
        parseReason: err.reason,
      },
    };
  }
  if (err instanceof WorkspaceAccessDenied) {
    return {
      content: [
        {
          type: "text",
          text: `[orchestrator] identity "${err.identityId}" is not a member of workspace "${err.wsId}".`,
        },
      ],
      isError: true,
      structuredContent: {
        error: "orchestrator_error",
        reason: "workspace_access_denied",
        identityId: err.identityId,
        wsId: err.wsId,
      },
    };
  }
  if (err instanceof UnknownToolSource) {
    return {
      content: [
        {
          type: "text",
          text: `[orchestrator] no source "${err.sourceName}" registered in workspace "${err.wsId}" for tool "${err.toolName}".`,
        },
      ],
      isError: true,
      structuredContent: {
        error: "orchestrator_error",
        reason: "unknown_tool_source",
        wsId: err.wsId,
        sourceName: err.sourceName,
        toolName: err.toolName,
      },
    };
  }
  if (err instanceof UnknownIdentitySource) {
    return {
      content: [
        {
          type: "text",
          text: `[orchestrator] no identity source "${err.sourceName}" for "${err.toolName}".`,
        },
      ],
      isError: true,
      structuredContent: {
        error: "orchestrator_error",
        reason: "unknown_identity_source",
        toolName: err.toolName,
      },
    };
  }
  if (err instanceof ConnectorGrantDenied) {
    return {
      content: [
        {
          type: "text",
          text: `[orchestrator] "${err.connector}" is your personal connector and isn't granted to this workspace. Grant it in Settings → Connectors, then retry.`,
        },
      ],
      isError: true,
      structuredContent: {
        error: "orchestrator_error",
        reason: "connector_grant_denied",
        connector: err.connector,
        wsId: err.workspaceId,
      },
    };
  }
  // Re-throw anything we don't recognize — surfaces via `run.error`.
  // No silent default reason: that would conflate a regression in the
  // orchestrator's error taxonomy with the deliberate classes above.
  void namespacedName;
  throw err;
}
