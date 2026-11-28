/**
 * The one place a request to a bound server gets its host context:
 * `stampHostContext` sets `params._meta["ai.nimblebrain/context"]` and keeps the
 * rest of `_meta`, replacing whatever value a caller put at that key.
 */

import { describe, expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/client";
import {
  HOST_CONTEXT_META_KEY,
  stamped,
  stampHostContext,
} from "../../../src/plugins/bound-servers.ts";

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

describe("stamped", () => {
  /** A transport that records what it is asked to send. */
  function recording(): { transport: Transport; sent: unknown[] } {
    const sent: unknown[] = [];
    const transport: Transport = {
      start: async () => {},
      close: async () => {},
      send: async (message) => {
        sent.push(message);
      },
    };
    return { transport, sent };
  }

  test("every request carries now, the host's clock as it is sent, over a caller's value", async () => {
    const { transport, sent } = recording();
    stamped(transport, undefined);
    const before = Date.now();
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "due",
        _meta: { [HOST_CONTEXT_META_KEY]: { principal: "host", now: "1999-01-01T00:00:00Z" } },
      },
    });
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const after = Date.now();
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      const context = paramsOf(message)._meta[HOST_CONTEXT_META_KEY] as Record<string, unknown>;
      expect(context.principal).toBe("person");
      expect(context.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/);
      const at = Date.parse(context.now as string);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);
    }
  });

  test("leaves notifications unstamped", async () => {
    const { transport, sent } = recording();
    stamped(transport, undefined);
    const note = { jsonrpc: "2.0" as const, method: "notifications/initialized" };
    await transport.send(note);
    expect(sent[0]).toBe(note);
  });
});
