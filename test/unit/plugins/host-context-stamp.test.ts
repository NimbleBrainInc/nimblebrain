/**
 * The one place a request to a bound server gets its host context:
 * `stampHostContext` sets `params._meta["ai.nimblebrain/context"]` and keeps the
 * rest of `_meta`, replacing whatever value a caller put at that key.
 */

import { describe, expect, test } from "bun:test";
import { HOST_CONTEXT_META_KEY, stampHostContext } from "../../../src/plugins/bound-servers.ts";

/** The params of a stamped request. */
function paramsOf(message: unknown): { name?: string; _meta: Record<string, unknown> } {
  return (message as { params: { name?: string; _meta: Record<string, unknown> } }).params;
}

const person = { principal: "person" as const, workspaceId: "ws_a", ownerId: "u_1" };

describe("stampHostContext", () => {
  test("overwrites a caller's context and keeps every other _meta key", () => {
    const out = paramsOf(
      stampHostContext(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create",
            _meta: { [HOST_CONTEXT_META_KEY]: { principal: "host" }, other: 1 },
          },
        },
        person,
      ),
    );
    expect(out.name).toBe("create");
    expect(out._meta).toEqual({ [HOST_CONTEXT_META_KEY]: person, other: 1 });
  });

  test("adds the context to a request with no params", () => {
    const out = paramsOf(stampHostContext({ jsonrpc: "2.0", id: 2, method: "tools/list" }, person));
    expect(out._meta[HOST_CONTEXT_META_KEY]).toEqual(person);
  });

  test("leaves notifications and responses alone", () => {
    const note = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
    expect(stampHostContext(note, person)).toBe(note);
    const response = { jsonrpc: "2.0" as const, id: 3, result: {} };
    expect(stampHostContext(response, person)).toBe(response);
  });
});
