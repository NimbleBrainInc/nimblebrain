/**
 * Map orchestrator errors to engine-shaped `ToolResult`s.
 *
 * `routeToolCall` throws a small, deliberate set of classes (see `./route.ts`).
 * Tool routers that compose `routeToolCall` and surface results to the engine
 * need to render those throws as `isError: true` results — the engine treats
 * thrown errors as run-level failures (`run.error`), not per-call failures,
 * which is the wrong shape for "you called a tool name we couldn't route."
 *
 * Five distinct `data.reason` values so HTTP / audit consumers can
 * differentiate failure modes without parsing the human message
 * (Stage 1 lesson 2 — conflating errors hides real bugs):
 *
 *   - `UnknownNamespacedToolName` → `invalid_tool_name`        + `{ name, parseReason }`
 *   - `UnknownWorkspace`          → `unknown_workspace`        + `{ wsId }`
 *   - `WorkspaceAccessDenied`     → `workspace_access_denied`  + `{ identityId, wsId }`
 *   - `UnknownToolSource`         → `unknown_tool_source`      + `{ wsId, sourceName, toolName }`
 *   - `UnknownIdentitySource`     → `unknown_identity_source`  + `{ toolName }`
 *
 * Non-orchestrator errors re-throw — those are real engine failures and
 * should hit the engine's `run.error` path. We deliberately do NOT
 * `?? "unknown"` here: an unrecognized class is a programmer error worth
 * surfacing as a thrown engine error rather than masking as a tool error.
 */

import type { ToolResult } from "../engine/types.ts";
import {
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  UnknownWorkspace,
  WorkspaceAccessDenied,
} from "./route.ts";

export function mapOrchestratorErrorToToolResult(
  err: unknown,
  namespacedName: string,
): ToolResult {
  if (err instanceof UnknownNamespacedToolName) {
    return {
      content: [
        {
          type: "text",
          text: `[orchestrator] invalid tool name "${err.input}": ${err.message} (no fallback to current workspace — use a fully namespaced tool name).`,
        },
      ],
      isError: true,
      structuredContent: {
        error: "orchestrator_error",
        reason: "invalid_tool_name",
        name: err.input,
        parseReason: err.reason,
      },
    };
  }
  if (err instanceof UnknownWorkspace) {
    return {
      content: [
        {
          type: "text",
          text: `[orchestrator] unknown workspace "${err.wsId}" (typo, deleted workspace, or cross-tenant accident) — call refused.`,
        },
      ],
      isError: true,
      structuredContent: {
        error: "orchestrator_error",
        reason: "unknown_workspace",
        wsId: err.wsId,
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
  // Re-throw anything we don't recognize — surfaces via `run.error`.
  // No silent default reason: that would conflate a regression in the
  // orchestrator's error taxonomy with the deliberate classes above.
  void namespacedName;
  throw err;
}
