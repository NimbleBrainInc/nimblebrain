/**
 * Stage 2 — Smoke: external MCP client cross-workspace dispatch (T011).
 *
 * Proves the spec line: "External MCP test: Claude Desktop sees aggregated
 * tool list, can invoke cross-workspace." This is the contract verification
 * for the Stage 2 cross-workspace requirement. Smoke tier per `CLAUDE.md` § Testing — runs under
 * `bun run smoke`, NOT `bun run test`.
 *
 * Every `it(...)` block names the failure mode it pins. The cases below
 * map 1:1 to the task's Tests Required list:
 *
 *  1. Initialize without `X-Workspace-Id` — server accepts; session id
 *     returned. Pins: regression that re-requires the header.
 *  2. Aggregated `tools/list` — entries from BOTH workspaces appear.
 *     Pins: regression where the endpoint only lists the user's "default"
 *     workspace tools (a single-workspace test would silently pass).
 *  3. Cross-workspace dispatch — per-source counters at exactly 1 each.
 *     Pins: a naive impl that pins the session to one workspace; the
 *     wrong counter ticks while the other stays at zero.
 *  4. Session survives without a switcher — multiple cross-workspace
 *     calls succeed on the same session id, no header changes.
 *  5. Strict invariant — un-namespaced `tools/call` rejects with a
 *     JSON-RPC error, NOT a silent route to the user's personal
 *     workspace (Stage 1 lesson 3).
 *  6. Audit attribution — handlers see `RequestContext.workspaceId` set
 *     to the parsed-from-namespace workspace, NOT the session's default.
 *     Read directly from the per-workspace audit trail captured at
 *     handler-execution time — independent of any envelope the server
 *     might return (Stage 1 lesson 2: envelopes hid misattribution
 *     twice).
 *  7. Connector-from-personal — the personal-workspace tool succeeds
 *     end-to-end through the real `/mcp` transport. This is the T008
 *     carryover proof: legacy `oauthScope: "user"` connectors are now
 *     bound to the personal workspace (per T003 + T008), and external
 *     clients can invoke them.
 *
 * Non-negotiables (from the task's Audit Criteria):
 *
 *  - Real `/mcp` transport — SDK `Client` + `StreamableHTTPClientTransport`.
 *    Do NOT call `mcpServer.handle()` or any in-process shortcut. Stage 1
 *    lesson 1: test the topology, not the API surface.
 *  - Topology verified by per-source counters AND per-handler audit
 *    trails — output strings alone passed Stage 1 broadcast bugs twice.
 *  - No flake harness: no retries, no `setTimeout`. Race conditions
 *    surface as test failures; we don't paper over them.
 *  - Smoke-tier classification: file lives in `test/smoke/`, picked up
 *    by `bun run smoke`, excluded from `bun run test`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type ServerHandle, startServer } from "../../src/api/server.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import {
  createTwoWorkspaceFixture,
  type TwoWorkspaceFixture,
} from "../helpers/two-workspace-fixture.ts";

// ── Fixture lifetime ──────────────────────────────────────────────
//
// One Runtime + one server for the whole file. Per-test isolation comes
// from resetting the counters/audit trails between cases.
//
// We bind the fixture to `DEV_IDENTITY` because `startServer()` with no
// provider configured spins up a `DevIdentityProvider` whose
// `verifyRequest()` returns `DEV_IDENTITY`. The fixture's default identity
// (`user_a`) would not match what the auth middleware resolves on every
// /mcp request — provisioning the shared+personal workspaces under
// `DEV_IDENTITY` is the load-bearing detail that lets `tools/list`
// aggregate both.

let fixture: TwoWorkspaceFixture;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  fixture = await createTwoWorkspaceFixture({ identity: DEV_IDENTITY });
  handle = startServer({ runtime: fixture.runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await fixture.cleanup();
});

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Build an MCP SDK `Client` against the running `/mcp` endpoint, with
 * NO `X-Workspace-Id` header — the contract under test is that `/mcp` is
 * identity-bound (T007), so the header is purely advisory and routing
 * derives the target workspace from the namespaced tool name on every
 * call. This is the exact protocol surface Claude Desktop / Claude Code
 * speak (Streamable HTTP), so any wire-protocol regression surfaces here.
 */
async function createExternalClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  const client = new Client({ name: "stage-2-t011-smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Reset the per-workspace counters AND audit trails between cases. */
function resetWorkspaceProbes(): void {
  fixture.shared.resetCallCount();
  fixture.shared.resetAuditTrail();
  fixture.personal.resetCallCount();
  fixture.personal.resetAuditTrail();
}

// ── Tests ─────────────────────────────────────────────────────────

describe("external MCP cross-workspace (Stage 2 T011 smoke)", () => {
  // ── 1. Initialize without workspace header ──────────────────────
  //
  // Pins: a regression that re-requires `X-Workspace-Id` on `initialize`
  // would 4xx here. The session id MUST come back in the `Mcp-Session-Id`
  // response header so subsequent requests can address the right
  // transport.
  it("initialize succeeds without X-Workspace-Id and returns a session id (failure mode: workspace-required init)", async () => {
    // Hit `/mcp` at the raw HTTP layer once so we can directly read the
    // `Mcp-Session-Id` response header. The SDK client wraps the
    // transport and hides the response Response object, so this is the
    // only way to assert the header surfaces verbatim from the server.
    const initRes = await fetch(`${baseUrl}/mcp`, {
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
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t011-smoke-init", version: "1.0.0" },
        },
      }),
    });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    // Assert non-null first so subsequent narrowing is type-clean
    // without `??` fallbacks (a fallback would mask a regression where
    // the server returned no session id at all).
    expect(sessionId).not.toBeNull();
    if (sessionId === null) throw new Error("unreachable — assertion above");
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    // Tidy. Drain the body before deleting so Bun doesn't complain about
    // an unconsumed stream, then close the session via the spec's DELETE.
    await initRes.body?.cancel();
    await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
  });

  // ── 2. Aggregated tools/list ───────────────────────────────────
  //
  // Pins: a regression where `/mcp` only lists the user's "default"
  // workspace tools would silently pass any single-workspace test.
  // Explicitly assert BOTH namespaced names appear so a future
  // "scope tools to session.workspaceId" reintroduction fails loudly.
  it("tools/list returns the aggregated namespaced names from BOTH workspaces (failure mode: single-workspace scoping)", async () => {
    const client = await createExternalClient();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain(fixture.shared.qualifiedToolName);
      expect(names).toContain(fixture.personal.qualifiedToolName);
    } finally {
      await client.close();
    }
  });

  // ── 3. Cross-workspace dispatch (topology — Stage 1 lesson 1) ───
  //
  // Pins: a naive impl that pins the session to one workspace would
  // route BOTH calls to that workspace; the per-source counters expose
  // it (`2,0` or `0,2` instead of `1,1`). Output-only assertions would
  // silently pass because each source's handler echoes its own name.
  //
  // The cases share ONE session id (one MCP client = one session) — the
  // contract is that cross-workspace dispatch works within a single
  // session, not by allocating a fresh session per call.
  it("two tools/call invocations route to distinct workspaces in the same session (failure mode: dispatch-to-current-workspace)", async () => {
    resetWorkspaceProbes();
    const client = await createExternalClient();
    try {
      const a = await client.callTool({
        name: fixture.shared.qualifiedToolName,
        arguments: { echo: "shared-a" },
      });
      const b = await client.callTool({
        name: fixture.personal.qualifiedToolName,
        arguments: { echo: "personal-b" },
      });
      expect(a.isError).toBeFalsy();
      expect(b.isError).toBeFalsy();

      // Exact-count assertion: `toHaveBeenCalledTimes(1)`-style guard.
      // "At-least-once" would hide a stub-source double-dispatch bug;
      // we want the naive pin-to-one-workspace failure (`2,0` / `0,2`)
      // to fail loudly here.
      expect(fixture.shared.callCount()).toBe(1);
      expect(fixture.personal.callCount()).toBe(1);
    } finally {
      await client.close();
    }
  });

  // ── 4. Session survives multiple cross-workspace calls (no switcher) ─
  //
  // External MCP has no workspace switcher concept — the bridge analog
  // (`setActiveWorkspaceId`) doesn't exist. Multiple cross-workspace
  // calls on the SAME session id must succeed with NO header changes
  // between them. A regression that ties session lifecycle to "active
  // workspace" (Stage 1 pre-Q3 behavior) would invalidate the session
  // after the first cross-workspace hop.
  it("multiple cross-workspace calls on one session id succeed without header changes (failure mode: session reset on workspace switch)", async () => {
    resetWorkspaceProbes();
    const client = await createExternalClient();
    try {
      // Interleave shared → personal → shared → personal. The SDK
      // client holds a single `Mcp-Session-Id` across all four calls.
      // If the session reset on any "workspace boundary" the third call
      // (or its successor) would 404.
      await client.callTool({
        name: fixture.shared.qualifiedToolName,
        arguments: { echo: "a" },
      });
      await client.callTool({
        name: fixture.personal.qualifiedToolName,
        arguments: { echo: "b" },
      });
      await client.callTool({
        name: fixture.shared.qualifiedToolName,
        arguments: { echo: "c" },
      });
      await client.callTool({
        name: fixture.personal.qualifiedToolName,
        arguments: { echo: "d" },
      });

      expect(fixture.shared.callCount()).toBe(2);
      expect(fixture.personal.callCount()).toBe(2);
    } finally {
      await client.close();
    }
  });

  // ── 5. Strict invariant — un-namespaced call rejects (lesson 3) ─
  //
  // Pins: a defensive default that silently routes un-prefixed names
  // to the user's personal workspace makes a class of LLM mistakes
  // succeed in the wrong place. The contract is fail-loud: JSON-RPC
  // `-32602` with `data.reason: "invalid_tool_name"`.
  //
  // Critical adversarial detail: neither workspace's counter may
  // increment. A regression that "fails the call but routes to the
  // user's personal workspace anyway" would still tick the personal
  // counter — we assert it stays at zero.
  it("tools/call with un-namespaced name rejects with -32602 invalid_tool_name and does NOT route anywhere (failure mode: silent fallback)", async () => {
    resetWorkspaceProbes();
    const client = await createExternalClient();
    try {
      let errorCode: number | undefined;
      let dataReason: string | undefined;
      try {
        await client.callTool({
          // No `ws_<id>/` prefix — orchestrator MUST refuse.
          name: `${fixture.shared.sourceName}__${fixture.shared.toolName}`,
          arguments: { echo: "noop" },
        });
      } catch (err) {
        const e = err as { code?: number; data?: { reason?: string } };
        errorCode = e.code;
        dataReason = e.data?.reason;
      }

      expect(errorCode).toBe(-32602);
      expect(dataReason).toBe("invalid_tool_name");

      // Adversarial: a silent fallback would tick the personal counter.
      // Neither side may move.
      expect(fixture.shared.callCount()).toBe(0);
      expect(fixture.personal.callCount()).toBe(0);
    } finally {
      await client.close();
    }
  });

  // ── 6. Audit attribution (Stage 1 lesson 2) ─────────────────────
  //
  // Pins: the runtime's per-call `RequestContext.workspaceId` carries
  // the parsed-from-namespace workspace — NOT the session's default,
  // NOT the request's `X-Workspace-Id` header. The audit trail is
  // captured by each source's handler at execution time
  // (`getRequestContext()?.workspaceId`), so the value we read is the
  // *exact ambient state* the tool ran under — the same state any
  // workspace-scoped data access (credentials, conversation lookups,
  // etc.) would observe.
  //
  // Why this is independent from case 3: an implementation could
  // correctly route the call to the right source (counter ticks
  // correctly) while still leaving `RequestContext.workspaceId` set to
  // the session's default. Stage 1's broadcast bugs ran this exact
  // play in reverse — outputs looked right but attribution was wrong.
  // Reading the audit trail directly (not from a server-returned
  // `ChatResult` envelope) is the structural guard.
  it("audit attribution — handlers see RequestContext.workspaceId stamped from the parsed namespace, not the session default (failure mode: session-default attribution)", async () => {
    resetWorkspaceProbes();
    const client = await createExternalClient();
    try {
      await client.callTool({
        name: fixture.shared.qualifiedToolName,
        arguments: { echo: "for-audit-shared" },
      });
      await client.callTool({
        name: fixture.personal.qualifiedToolName,
        arguments: { echo: "for-audit-personal" },
      });

      const sharedAudit = fixture.shared.auditTrail();
      const personalAudit = fixture.personal.auditTrail();

      // One entry per call — same arity as the counters.
      expect(sharedAudit).toHaveLength(1);
      expect(personalAudit).toHaveLength(1);

      // The load-bearing assertion: each handler saw the
      // parsed-from-namespace workspace id, NOT the other one and NOT
      // the absent-context sentinel. A regression that stamps the
      // session-default workspace onto every call would land BOTH
      // entries on the same id; this catches it.
      expect(sharedAudit[0]).toBe(fixture.shared.id);
      expect(personalAudit[0]).toBe(fixture.personal.id);
      expect(sharedAudit[0]).not.toBe(fixture.personal.id);
      expect(personalAudit[0]).not.toBe(fixture.shared.id);
    } finally {
      await client.close();
    }
  });

  // ── 7. Connector-from-personal (T008 carryover proof) ───────────
  //
  // Pre-Stage-2, connectors were installed with `oauthScope: "user"`
  // and their credentials lived at `users/{u}/credentials/...`. T003's
  // migration moved them to `workspaces/ws_user_{u}/credentials/...`;
  // T008's loader normalization rewrites legacy records on read so the
  // runtime never sees `"user"`. The personal workspace's source in
  // this fixture stands in for one of those connectors: it lives in
  // the user's personal workspace, addressed under
  // `personalWorkspaceIdFor(identity.id)`.
  //
  // This case proves the round-trip end-to-end through the real `/mcp`
  // transport: an external client (no `X-Workspace-Id` header)
  // invokes the personal-workspace tool, the call reaches the right
  // source, and the handler sees the personal-workspace id in its
  // ambient request context. If T008's normalization were broken
  // (e.g. a `"user"` record loaded with no workspace binding), the
  // tool wouldn't even appear in `tools/list`, let alone dispatch.
  it("connector bound to personal workspace dispatches via external MCP (T008 carryover proof)", async () => {
    resetWorkspaceProbes();
    const client = await createExternalClient();
    try {
      // The personal-workspace tool — exactly the kind of connector
      // that was previously `oauthScope: "user"` and is now bound to
      // the personal workspace by T003 + T008.
      const result = await client.callTool({
        name: fixture.personal.qualifiedToolName,
        arguments: { echo: "connector-from-personal" },
      });
      expect(result.isError).toBeFalsy();

      // Source-level dispatch landed in the personal workspace and
      // NOT the shared one.
      expect(fixture.personal.callCount()).toBe(1);
      expect(fixture.shared.callCount()).toBe(0);

      // Attribution: the handler ran with the personal workspace id
      // in its ambient request context — credentials lookup, audit
      // attribution, and any other workspace-scoped access would
      // resolve to the right tenant boundary.
      const personalAudit = fixture.personal.auditTrail();
      expect(personalAudit).toHaveLength(1);
      expect(personalAudit[0]).toBe(fixture.personal.id);
    } finally {
      await client.close();
    }
  });
});
