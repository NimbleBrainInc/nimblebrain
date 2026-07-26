/**
 * `PersonalConnectorRequiresMarker` must reach the caller through BOTH doors.
 *
 * This is the gap that let the bug ship: the error was thrown on the dispatch
 * path and mapped by neither mapper, so it fell through to the generic rethrow.
 * On the chat door that fails the ENTIRE agent run instead of returning a
 * recoverable result — and the message, which names the marked form the model
 * should call instead, is written for the model and never reaches it. On `/mcp`
 * a raw non-`McpError` escapes the `tools/call` handler.
 *
 * The route-layer test asserting `rejects.toBeInstanceOf` passed throughout,
 * because it never went through a mapper. Hence these.
 */

import { describe, expect, test } from "bun:test";
import { mapRouteToolError } from "../../../src/api/mcp-server.ts";
import { mapOrchestratorErrorToToolResult } from "../../../src/orchestrator/error-mapping.ts";
import { PersonalConnectorRequiresMarker } from "../../../src/orchestrator/index.ts";

const stale = () => new PersonalConnectorRequiresMarker("granola__list", "granola", "my_granola");

describe("chat door — mapOrchestratorErrorToToolResult", () => {
  test("returns a recoverable isError result, never rethrows", () => {
    // The rethrow path is what fails the whole run.
    expect(() => mapOrchestratorErrorToToolResult(stale(), "granola__list")).not.toThrow();
    const r = mapOrchestratorErrorToToolResult(stale(), "granola__list");
    expect(r.isError).toBe(true);
  });

  test("carries the structured discriminator and the marked form", () => {
    const r = mapOrchestratorErrorToToolResult(stale(), "granola__list");
    expect(r.structuredContent).toMatchObject({
      reason: "personal_connector_requires_marker",
      sourceName: "granola",
      wireName: "my_granola",
    });
  });

  test("the model-visible text names the form to call instead", () => {
    // The whole point of returning rather than throwing: the model reads this
    // and can re-call correctly inside the same run.
    const text = JSON.stringify(mapOrchestratorErrorToToolResult(stale(), "granola__list"));
    expect(text).toContain("my_granola");
  });

});

describe("/mcp door — mapRouteToolError", () => {
  test("throws a structured McpError, not a raw Error", () => {
    let thrown: unknown = null;
    try {
      mapRouteToolError(stale());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    // A raw Error escaping the handler is the failure this pins.
    expect((thrown as { code?: number }).code).toBeDefined();
    expect((thrown as { data?: { reason?: string } }).data?.reason).toBe(
      "personal_connector_requires_marker",
    );
  });

  test("both doors report the SAME discriminator", () => {
    // AGENTS.md claims chat and /mcp map to identical `data.reason` values.
    const chat = mapOrchestratorErrorToToolResult(stale(), "granola__list");
    let mcpReason: string | undefined;
    try {
      mapRouteToolError(stale());
    } catch (err) {
      mcpReason = (err as { data?: { reason?: string } }).data?.reason;
    }
    expect((chat.structuredContent as { reason: string }).reason).toBe(mcpReason as string);
  });
});
