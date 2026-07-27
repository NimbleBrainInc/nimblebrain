/**
 * Build a retired `ws_<id>-<toolName>` wire name — TEST FIXTURES ONLY.
 *
 * Nothing constructs this form any more: it is rejected rather than routed. The
 * builder survives because fixtures must produce a WELL-FORMED retired name in
 * order to assert it is refused, and a validated constructor beats a spliced
 * string that might be refused for the wrong reason.
 *
 * It lives here, not in `src/`, because `package.json` ships `src/` to
 * consumers — a builder for a form the platform no longer emits would be dead
 * code in the published package. `scripts/check-tool-namespace.ts` scans `src/`
 * and `web/src/` only, so fixtures are unaffected by its lint.
 */

import { WORKSPACE_ID_RE } from "../../src/workspace/workspace-id-pattern.ts";

/**
 * Thrown by `namespacedToolName` when either operand is invalid. Separate
 * class so callers can distinguish a malformed input string (parse-side)
 * from a malformed construction request (build-side); both are
 * programmer errors but they originate in different layers.
 */
export class InvalidNamespacedToolNameInput extends Error {
  readonly wsId: string;
  readonly toolName: string;
  readonly reason: string;

  constructor(wsId: string, toolName: string, reason: string, message: string) {
    super(message);
    this.name = "InvalidNamespacedToolNameInput";
    this.wsId = wsId;
    this.toolName = toolName;
    this.reason = reason;
  }
}

/**
 * Build a namespaced tool name from a workspace id and a tool name.
 *
 * Returns `ws_<id>-<name>`. Throws `InvalidNamespacedToolNameInput`
 * on any invalid input:
 *   - `wsId` missing, empty, non-string, or failing `WORKSPACE_ID_RE`
 *     (path-traversal, whitespace, wrong prefix all rejected here).
 *   - `name` missing, empty, or non-string.
 *
 * No `??`/`||` defaulting; every invalid shape is fail-loud. The
 * orchestrator must surface the error rather than fall back to a
 * "current workspace."
 */
export function namespacedToolName(wsId: string, name: string): string {
  if (typeof wsId !== "string" || wsId.length === 0) {
    throw new InvalidNamespacedToolNameInput(
      String(wsId),
      String(name),
      "empty_workspace_id",
      "[tools/namespace] namespacedToolName: wsId is required (non-empty string)",
    );
  }
  if (!WORKSPACE_ID_RE.test(wsId)) {
    throw new InvalidNamespacedToolNameInput(
      wsId,
      String(name),
      "invalid_wsid",
      `[tools/namespace] namespacedToolName: invalid wsId "${wsId}" (must match WORKSPACE_ID_RE)`,
    );
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new InvalidNamespacedToolNameInput(
      wsId,
      String(name),
      "empty_tool_name",
      "[tools/namespace] namespacedToolName: tool name is required (non-empty string)",
    );
  }
  return `${wsId}-${name}`;
}
