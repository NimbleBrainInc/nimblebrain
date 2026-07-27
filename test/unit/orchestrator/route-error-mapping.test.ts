/**
 * Routing errors, asserted THROUGH the mappers.
 *
 * A route-layer assertion (`rejects.toBeInstanceOf`) proves an error is thrown.
 * It says nothing about whether the caller ever receives it — and this branch
 * shipped exactly that gap once: a class thrown on the dispatch path and mapped
 * by neither mapper fell through to the generic rethrow, which fails the whole
 * agent run and drops the model-facing remedy on the floor.
 *
 * So the live classes are pinned here, at the boundary, for both doors.
 */

import { describe, expect, test } from "bun:test";
import { mapRouteToolError } from "../../../src/api/mcp-server.ts";
import { mapOrchestratorErrorToToolResult } from "../../../src/orchestrator/error-mapping.ts";
import { UnknownIdentitySource, UnknownToolSource } from "../../../src/orchestrator/index.ts";
import { UnknownNamespacedToolName } from "../../../src/tools/namespace.ts";

const legacy = () =>
  new UnknownNamespacedToolName(
    "ws_helix-crm__search",
    "legacy_namespaced_form",
    `[orchestrator] "ws_helix-crm__search" uses the retired ws_<id>- tool-name form; re-list tools and call "crm__search"`,
  );

function mcpError(err: unknown): { code?: number; data?: { reason?: string }; message?: string } {
  try {
    mapRouteToolError(err);
  } catch (thrown) {
    return thrown as { code?: number; data?: { reason?: string }; message?: string };
  }
  throw new Error("mapRouteToolError did not throw");
}

describe("the retired ws_<id>- form — the rollout hot path", () => {
  // A conversation resumed across the upgrade has prefixed names in history and
  // bare names in its tool list, so it WILL produce legacy names. Whatever the
  // caller reads has to point at the name that works.
  test("chat door returns a recoverable result naming the bare tool", () => {
    const r = mapOrchestratorErrorToToolResult(legacy(), "ws_helix-crm__search");
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("crm__search");
    // The remedy must not be contradicted by boilerplate telling the model to do
    // the opposite of what the message just said.
    expect(text).not.toMatch(/fully namespaced/i);
  });

  test("/mcp door carries the same guidance, not a fixed string", () => {
    const e = mcpError(legacy());
    expect(e.code).toBe(-32602);
    expect(e.message).toContain("crm__search");
  });
});

describe("every live routing class reaches the caller on both doors", () => {
  const cases: [string, unknown, string][] = [
    ["UnknownNamespacedToolName", legacy(), "invalid_tool_name"],
    ["UnknownToolSource", new UnknownToolSource("ws_helix", "crm__search", "crm"), "unknown_tool_source"],
    ["UnknownIdentitySource", new UnknownIdentitySource("nope__x", "nope"), "unknown_identity_source"],
  ];

  for (const [name, err, reason] of cases) {
    test(`${name} → ${reason}, identically on chat and /mcp`, () => {
      // Neither door may fall through to its generic rethrow: on chat that fails
      // the entire run rather than returning a recoverable tool result.
      const chat = mapOrchestratorErrorToToolResult(err, "x");
      expect(chat.isError).toBe(true);
      expect((chat.structuredContent as { reason: string }).reason).toBe(reason);
      expect(mcpError(err).data?.reason).toBe(reason);
    });
  }
});
