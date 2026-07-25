/**
 * End-to-end validation of the `ManagedConnectorProvider` seam against a REAL
 * broker: mint a Smithery session for `nimblebrain/bassethound` and speak MCP to
 * it.
 *
 * We own both ends — Bassethound is ours and the Smithery namespace is ours — so
 * any failure here is unambiguously in the seam rather than in an opaque
 * third-party server. That is the whole reason this pair was chosen as provider
 * #2's guinea pig.
 *
 * Skipped unless `SMITHERY_API_KEY` and `SMITHERY_NAMESPACE` are set, so CI and
 * OSS checkouts stay green without credentials. Run it with:
 *
 *   SMITHERY_API_KEY=… SMITHERY_NAMESPACE=nimblebrain \
 *     bun test test/integration/smithery-e2e.test.ts
 *
 * **The upstream's auth posture is not ours to control.** Bassethound requires
 * authorization through Smithery, so a fresh connection comes back
 * `auth_required` and `createSession` throws with the hosted setup URL — the
 * designed behavior, and what the runtime shows an operator. Completing that
 * setup is a one-time browser step against the Smithery account. Until it is
 * done the MCP round-trip cases **skip** rather than pass: a green run must
 * never overstate what actually ran.
 *
 * The session is resolved at MODULE scope for that reason — collection happens
 * before any hook, so a `beforeAll` flag could only produce an early `return`,
 * which reads as a pass. The connection it creates is deterministic per
 * (owner, server) and is torn down by the final test.
 */

import { describe, expect, it } from "bun:test";
import {
  getSmitheryConnection,
  type SmitheryClientOptions,
  smitheryConnectionId,
} from "../../src/connectors/providers/smithery/client.ts";
import {
  _resetSmitheryConfigForTest,
  validateSmitheryConfig,
} from "../../src/connectors/providers/smithery/config.ts";
import {
  cleanupSmitheryBundle,
  createSmitheryProvider,
} from "../../src/connectors/providers/smithery/provider.ts";

const HAVE_CREDS = Boolean(
  process.env.SMITHERY_API_KEY?.trim() && process.env.SMITHERY_NAMESPACE?.trim(),
);
const SERVER = "nimblebrain/bassethound";
const OWNER = { type: "workspace", wsId: "ws_seamcheck" } as const;

/** The minted session, or undefined when the broker wants setup completed first. */
let session: { type: string; url: string; providerRef?: Record<string, string> } | undefined;
/** Present instead of `session` when the connection needs a human at `setupUrl`. */
let notReady: { state: string; setupUrl?: string } | undefined;
let options: SmitheryClientOptions = { apiKey: "", baseUrl: "", namespace: "" };
let connectionId = "";
/** What the `smithery` credential provider attaches at transport-build time. */
let authHeaders: Record<string, string> = {};

if (HAVE_CREDS) {
  _resetSmitheryConfigForTest();
  const config = validateSmitheryConfig();
  options = {
    apiKey: (process.env.SMITHERY_API_KEY ?? "").trim(),
    baseUrl: config.baseUrl,
    namespace: config.namespace,
  };
  const provider = createSmitheryProvider();
  connectionId = smitheryConnectionId(provider.userId(OWNER), SERVER);
  authHeaders = { Authorization: `Bearer ${options.apiKey}` };

  try {
    session = await provider.createSession({ userId: provider.userId(OWNER), toolkit: SERVER });
  } catch (err) {
    const e = err as { name?: string; state?: string; setupUrl?: string };
    if (e.name !== "SmitheryConnectionNotReadyError") throw err;
    notReady = { state: e.state ?? "unknown", setupUrl: e.setupUrl };
  }
}

/** One JSON-RPC round-trip against a remote MCP endpoint, honoring the SSE-or-JSON response. */
async function mcpCall(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);

  // Streamable HTTP may answer as SSE; take the last `data:` frame.
  if (text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")) {
    const frames = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    const last = frames.at(-1);
    if (!last) throw new Error(`No SSE data frame in response: ${text.slice(0, 400)}`);
    return JSON.parse(last);
  }
  return JSON.parse(text);
}

describe.skipIf(!HAVE_CREDS)(
  "Smithery provider — end-to-end against nimblebrain/bassethound",
  () => {
    it("reaches the real broker and answers with a usable session or a setup URL", () => {
      // Either outcome proves the Connect round-trip worked; which one depends
      // on the upstream's auth posture, which this suite does not control.
      if (session) {
        expect(session.type).toBe("http");
        expect(session.url).toContain(`/connect/${options.namespace}/${connectionId}/mcp`);
        // The session carries no credential — that is the credential provider's job.
        expect((session as { headers?: unknown }).headers).toBeUndefined();
        expect(session.providerRef).toMatchObject({ connectionId, namespace: options.namespace });
        return;
      }
      // The not-ready path is what an operator sees, so assert it names the remedy.
      expect(notReady?.state).toBe("auth_required");
      expect(notReady?.setupUrl).toContain("smithery");
    });

    it.skipIf(!session)("serves a real MCP handshake over the brokered session", async () => {
      const result = await mcpCall(session?.url ?? "", authHeaders, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "nimblebrain-seam-check", version: "0" },
        },
      });

      expect(result.error).toBeUndefined();
      const serverInfo = (result.result as { serverInfo?: { name?: string } })?.serverInfo;
      expect(serverInfo?.name).toBeTruthy();
    });

    it.skipIf(!session)(
      "exposes Bassethound's own tool surface through the brokered session",
      async () => {
        const result = await mcpCall(session?.url ?? "", authHeaders, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        });

        expect(result.error).toBeUndefined();
        const tools = (result.result as { tools?: Array<{ name: string }> })?.tools ?? [];
        // The seam brokers auth+session only — MCP still owns the tool surface,
        // so the server's own tool must arrive unmediated.
        expect(tools.map((t) => t.name)).toContain("sniff_domain");
      },
    );

    it.skipIf(!session)(
      "is idempotent — re-creating the session reuses the same connection",
      async () => {
        const provider = createSmitheryProvider();
        const again = await provider.createSession({
          userId: provider.userId(OWNER),
          toolkit: SERVER,
        });
        expect(again.url).toBe(session?.url);
        expect(again.providerRef?.connectionId).toBe(connectionId);
      },
    );

    // Last, because it destroys the connection the tests above share. This is
    // the uninstall path — the only teardown Smithery has — so it is asserted
    // rather than swept into a hook, where a silent failure would leak a
    // connection per run and nothing would say so. Runs in BOTH states: an
    // auth_required connection still exists at the broker and still needs it.
    it("tears the connection down at the broker on uninstall", async () => {
      const { upstreamDeleted, lastError } = await cleanupSmitheryBundle({
        connectionId,
        namespace: options.namespace,
        baseUrl: options.baseUrl,
      });
      expect(lastError).toBeUndefined();
      expect(upstreamDeleted).toBe(true);
      expect(await getSmitheryConnection(options, connectionId)).toBeNull();
    });
  },
);
