/**
 * Unit tests for `src/orchestrator/error-mapping.ts`.
 *
 * Pins the failure-mode taxonomy: every orchestrator error class maps to
 * a distinct `data.reason`, and non-orchestrator errors re-throw rather
 * than being silently swallowed. Stage 1 lesson 2 (conflating errors
 * hides real bugs) — these are five separate code paths.
 */

import { describe, expect, test } from "bun:test";

import { mapOrchestratorErrorToToolResult } from "../../../src/orchestrator/error-mapping.ts";
import {
  UnknownIdentitySource,
  UnknownToolSource,
  UnknownWorkspace,
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

  test("UnknownWorkspace → reason: unknown_workspace + wsId", () => {
    const err = new UnknownWorkspace("ws_missing");
    const result = mapOrchestratorErrorToToolResult(err, "ws_missing-crm__search");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      reason: "unknown_workspace",
      wsId: "ws_missing",
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
