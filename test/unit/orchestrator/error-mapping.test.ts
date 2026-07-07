/**
 * Unit tests for `src/orchestrator/error-mapping.ts`.
 *
 * Pins the failure-mode taxonomy: every orchestrator error class maps to
 * a distinct `data.reason`, and non-orchestrator errors re-throw rather
 * than being silently swallowed. Conflating errors hides real bugs —
 * each of these is a separate code path.
 */

import { describe, expect, test } from "bun:test";

import { mapOrchestratorErrorToToolResult } from "../../../src/orchestrator/error-mapping.ts";
import {
  ConnectorGrantDenied,
  UnknownIdentitySource,
  UnknownToolSource,
  WorkspaceAccessDenied,
} from "../../../src/orchestrator/index.ts";
import { UnknownNamespacedToolName } from "../../../src/tools/namespace.ts";

describe("mapOrchestratorErrorToToolResult", () => {
  test("UnknownNamespacedToolName → reason: invalid_tool_name", () => {
    const err = new UnknownNamespacedToolName("bad-name", "missing_double_underscore");
    const result = mapOrchestratorErrorToToolResult(err, "bad-name");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: "orchestrator_error",
      reason: "invalid_tool_name",
      name: "bad-name",
      parseReason: "missing_double_underscore",
    });
  });

  test("WorkspaceAccessDenied → reason: workspace_access_denied + identityId + wsId", () => {
    const err = new WorkspaceAccessDenied("u1", "ws_other");
    const result = mapOrchestratorErrorToToolResult(err, "ws_other-crm__search");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      reason: "workspace_access_denied",
      identityId: "u1",
      wsId: "ws_other",
    });
  });

  test("UnknownToolSource → reason: unknown_tool_source + wsId + sourceName + toolName", () => {
    const err = new UnknownToolSource("ws_helix", "missing__do", "missing");
    const result = mapOrchestratorErrorToToolResult(err, "ws_helix-missing__do");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      reason: "unknown_tool_source",
      wsId: "ws_helix",
      sourceName: "missing",
      toolName: "missing__do",
    });
  });

  test("UnknownIdentitySource → reason: unknown_identity_source + toolName", () => {
    const err = new UnknownIdentitySource("crm__search", "crm");
    const result = mapOrchestratorErrorToToolResult(err, "crm__search");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      reason: "unknown_identity_source",
      toolName: "crm__search",
    });
  });

  test("ConnectorGrantDenied → reason: connector_grant_denied + connector + wsId", () => {
    const err = new ConnectorGrantDenied("u1", "granola", "ws_helix");
    const result = mapOrchestratorErrorToToolResult(err, "granola__read_notes");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      reason: "connector_grant_denied",
      connector: "granola",
      wsId: "ws_helix",
    });
    // Actionable message the agent can relay to the user.
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("Settings");
  });

  // Pins: unknown error classes RE-THROW. A naive `?? "unknown"` default
  // would mask programmer errors (a new orchestrator error class added
  // without a mapping branch) under a generic reason.
  test("non-orchestrator errors are re-thrown, not coerced into a tool result", () => {
    const err = new Error("totally unrelated");
    expect(() => mapOrchestratorErrorToToolResult(err, "whatever")).toThrow(
      "totally unrelated",
    );
  });
});
