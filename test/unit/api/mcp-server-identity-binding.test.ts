/**
 * Unit tests for `/mcp` session identity binding.
 *
 * A `/mcp` session is bound to the identity that initialized it. A later
 * request presenting the same `Mcp-Session-Id` under a DIFFERENT identity must
 * NOT be dispatched into the owner's session — otherwise a leaked session id
 * lets a same-tenant user drive the owner's identity-scoped tools
 * (conversations/files/automations) as the owner. Reuse by the owning identity
 * must still work.
 *
 * Driven directly against `McpServerHost.handle` with a real initialize (to
 * populate the live transport map) and a hand-built `InMemorySessionRegistry`,
 * so the test needs no HTTP server and no auth provider — `sessionCtx.identity`
 * is supplied per call, which is exactly the seam an attacker would abuse.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { McpServerHost } from "../../../src/api/mcp-server.ts";
import {
  InMemorySessionRegistry,
  type SessionRegistry,
} from "../../../src/api/session-store/index.ts";
import type { ResolvedFeatures } from "../../../src/config/features.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";

const FAKE_FEATURES = {} as ResolvedFeatures;

function identity(id: string): UserIdentity {
  return { id, email: `${id}@localhost`, displayName: id, orgRole: "member", preferences: {} };
}

const ALICE = identity("usr_alice");
const MALLORY = identity("usr_mallory");

function initRequest(): Request {
  return new Request("http://test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "identity-binding-test", version: "1.0.0" },
      },
    }),
  });
}

function reuseRequest(sessionId: string, method: "POST" | "DELETE"): Request {
  return new Request("http://test/mcp", {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    ...(method === "POST"
      ? { body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }
      : {}),
  });
}

describe("McpServerHost — /mcp session identity binding", () => {
  let registry: SessionRegistry;
  let host: McpServerHost;

  beforeEach(() => {
    registry = new InMemorySessionRegistry({ ttlMs: 60_000 });
    // No runtime: tool handlers no-op, but the identity check runs before any
    // dispatch, so this suite exercises it in isolation.
    host = new McpServerHost({ registry, idleTtlMs: 60_000 });
  });

  afterEach(async () => {
    await host.shutdown();
  });

  async function initAs(who: UserIdentity): Promise<string> {
    const res = await host.handle(initRequest(), FAKE_FEATURES, { identity: who });
    const sid = res.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    return sid as string;
  }

  it("rejects POST reuse by a different identity with an opaque not_found 404, session untouched", async () => {
    const sid = await initAs(ALICE);
    expect(host.transportCount()).toBe(1);

    const res = await host.handle(reuseRequest(sid, "POST"), FAKE_FEATURES, { identity: MALLORY });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { data: { reason: string } } };
    // Opaque: a non-owner must not be able to tell an owned, live session
    // (`unavailable`) apart from a nonexistent one (`not_found`).
    expect(body.error.data.reason).toBe("not_found");
    // The owner's session is not evicted by the rejected reuse.
    expect(host.transportCount()).toBe(1);
  });

  it("allows POST reuse by the owning identity (dispatched, not a session miss)", async () => {
    const sid = await initAs(ALICE);
    const res = await host.handle(reuseRequest(sid, "POST"), FAKE_FEATURES, { identity: ALICE });
    // Owner is dispatched into the live transport — never a 404 session miss.
    expect(res.status).not.toBe(404);
  });

  it("rejects DELETE by a different identity and preserves the session", async () => {
    const sid = await initAs(ALICE);
    const res = await host.handle(reuseRequest(sid, "DELETE"), FAKE_FEATURES, { identity: MALLORY });
    expect(res.status).toBe(404);
    // A non-owner cannot tear down someone else's live session.
    expect(host.transportCount()).toBe(1);
  });

  it("allows DELETE by the owning identity", async () => {
    const sid = await initAs(ALICE);
    const res = await host.handle(reuseRequest(sid, "DELETE"), FAKE_FEATURES, { identity: ALICE });
    expect(res.status).not.toBe(404);
  });
});
