import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { resetRefreshExchanges } from "../../src/tools/oauth-refresh-fetch.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

/**
 * Some servers reject an access token in-band: HTTP 200, an `isError` result
 * whose text says the token expired, instead of the 401 the SDK refreshes on.
 * For a connection whose catalog entry declares that text, the transport reads
 * such a `tools/call` answer as a 401, so the SDK's own path renews the token
 * and retries once, and a refused renewal or a refused retry ends in
 * `reauth_required`.
 *
 * A real Streamable HTTP server (JSON and SSE answers both) and a real
 * `WorkspaceOAuthProvider`: the server accepts on `tools/call` only the access
 * tokens the test marks valid, and its token endpoint rotates refresh tokens.
 */

const WS = "ws_0076759dbbe19fcc";
const SERVER = "inband-srv";
const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";
const REJECTION =
  "Query failed: Your authentication token has expired or is invalid. Please refresh your token and retry.";
const PHRASE = "authentication token has expired or is invalid";

interface Vendor {
  url: string;
  issuer: string;
  /** Access tokens `tools/call` accepts; any other gets the in-band rejection. */
  accepted: Set<string>;
  /** Bearer of each `tools/call`, in order. */
  calls: string[];
  refreshPosts: () => number;
  stop: () => void;
}

function startVendor(opts: { json: boolean; refuse?: boolean; toolError?: string }): Vendor {
  const accepted = new Set<string>();
  const calls: string[] = [];
  let current = "rt_1";
  let issued = 1;
  let refreshPosts = 0;

  const httpServer = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const base = `http://localhost:${httpServer.port}`;
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        refreshPosts++;
        const form = await req.formData();
        if (opts.refuse || form.get("refresh_token") !== current) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        current = `rt_${++issued}`;
        return Response.json({
          access_token: `at_${issued}`,
          token_type: "Bearer",
          expires_in: 28800,
          refresh_token: current,
        });
      }
      if (url.pathname === "/mcp") {
        const bearer = req.headers.get("authorization")?.replace(/^Bearer /i, "");
        // No token at all is the one refusal this server answers to spec.
        if (!bearer) return new Response(null, { status: 401 });
        const mcp = new Server(
          { name: "inband", version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler("tools/list", async () => ({
          tools: [
            {
              name: "executeQuery",
              description: "query",
              inputSchema: { type: "object" as const, properties: {} },
            },
          ],
        }));
        mcp.setRequestHandler("tools/call", async () => {
          calls.push(bearer);
          if (opts.toolError) {
            return { content: [{ type: "text" as const, text: opts.toolError }], isError: true };
          }
          return accepted.has(bearer)
            ? { content: [{ type: "text" as const, text: "ok" }] }
            : { content: [{ type: "text" as const, text: REJECTION }], isError: true };
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: opts.json,
        });
        await mcp.connect(transport);
        return transport.handleRequest(req);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://localhost:${httpServer.port}`;
  return {
    url: `${base}/mcp`,
    issuer: base,
    accepted,
    calls,
    refreshPosts: () => refreshPosts,
    stop: () => httpServer.stop(true),
  };
}

function makeProvider(onAuthLost?: () => void): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: WS },
    serverName: SERVER,
    callbackUrl: CALLBACK,
    allowInsecureRemotes: true,
    ...(onAuthLost ? { onAuthLost } : {}),
  });
}

async function seedConnection(issuer: string): Promise<void> {
  const p = makeProvider();
  await p.saveClientInformation({ client_id: "client-1", redirect_uris: [CALLBACK] });
  await p.saveTokens({
    access_token: "at_1",
    token_type: "Bearer",
    refresh_token: "rt_1",
    issuer,
  } as Parameters<WorkspaceOAuthProvider["saveTokens"]>[0]);
}

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("\n");

for (const json of [true, false]) {
  describe(`McpSource — in-band access-token rejection (${json ? "JSON" : "SSE"} answers)`, () => {
    let vendor: Vendor;
    let source: McpSource | undefined;

    async function started(
      opts: { inBandAuthErrors?: string[]; refuse?: boolean; toolError?: string } = {},
    ) {
      vendor = startVendor({ json, refuse: opts.refuse, toolError: opts.toolError });
      vendor.accepted.add("at_1");
      await seedConnection(vendor.issuer);
      const onAuthLost = mock(() => {});
      source = new McpSource(
        SERVER,
        {
          type: "remote",
          url: new URL(vendor.url),
          allowInsecure: true,
          authProvider: makeProvider(onAuthLost),
          ...(opts.inBandAuthErrors ? { inBandAuthErrors: opts.inBandAuthErrors } : {}),
        },
        new NoopEventSink(),
      );
      await source.start();
      // Connected on at_1; from here the server refuses it in-band.
      vendor.accepted.delete("at_1");
      return { source, onAuthLost };
    }

    beforeEach(() => {
      const workDir = mkdtempSync(join(tmpdir(), "nb-inband-auth-"));
      seedWorkspaceRoot(workDir, WS);
      installTestCredentialStore(workDir);
      resetRefreshExchanges();
    });
    afterEach(async () => {
      await source?.stop();
      source = undefined;
      vendor?.stop();
      resetTestCredentialStore();
    });

    it("refreshes once and retries the call on the new token", async () => {
      const { source, onAuthLost } = await started({ inBandAuthErrors: [PHRASE] });
      vendor.accepted.add("at_2");

      const result = await source.execute("executeQuery", {});

      expect(result.isError).toBe(false);
      expect(textOf(result)).toBe("ok");
      expect(vendor.refreshPosts()).toBe(1);
      expect(vendor.calls).toEqual(["at_1", "at_2"]);
      expect(onAuthLost).not.toHaveBeenCalled();
    }, 15_000);

    it("a refused refresh flips reauth_required once", async () => {
      const { source, onAuthLost } = await started({ inBandAuthErrors: [PHRASE], refuse: true });

      const result = await source.execute("executeQuery", {});

      expect(result.isError).toBe(true);
      expect(result.structuredContent?.reason).toBe("reauth_required");
      expect(onAuthLost).toHaveBeenCalledTimes(1);
      expect(vendor.calls).toEqual(["at_1"]);
    }, 15_000);

    it("a refreshed token rejected too flips reauth_required", async () => {
      const { source, onAuthLost } = await started({ inBandAuthErrors: [PHRASE] });

      const result = await source.execute("executeQuery", {});

      expect(result.structuredContent?.reason).toBe("reauth_required");
      expect(vendor.refreshPosts()).toBe(1);
      expect(vendor.calls).toEqual(["at_1", "at_2"]);
      expect(onAuthLost).toHaveBeenCalledTimes(1);
    }, 15_000);

    it("renews again when a refreshed token that worked later expires", async () => {
      const { source, onAuthLost } = await started({ inBandAuthErrors: [PHRASE] });
      vendor.accepted.add("at_2");
      expect((await source.execute("executeQuery", {})).isError).toBe(false);
      expect((await source.execute("executeQuery", {})).isError).toBe(false);
      vendor.accepted.clear();
      vendor.accepted.add("at_3");

      const result = await source.execute("executeQuery", {});

      expect(result.isError).toBe(false);
      expect(vendor.refreshPosts()).toBe(2);
      expect(vendor.calls).toEqual(["at_1", "at_2", "at_2", "at_2", "at_3"]);
      expect(onAuthLost).not.toHaveBeenCalled();
    }, 15_000);

    it("parallel rejections spend one refresh and all recover", async () => {
      const { source, onAuthLost } = await started({ inBandAuthErrors: [PHRASE] });
      vendor.accepted.add("at_2");

      const results = await Promise.all(
        Array.from({ length: 5 }, () => source.execute("executeQuery", {})),
      );

      expect(results.every((r) => r.isError === false)).toBe(true);
      expect(vendor.refreshPosts()).toBe(1);
      expect(onAuthLost).not.toHaveBeenCalled();
    }, 15_000);

    it("a tool error without the declared text passes through with no refresh", async () => {
      const { source } = await started({
        inBandAuthErrors: [PHRASE],
        toolError: "Query failed: no such record",
      });

      const result = await source.execute("executeQuery", {});

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("no such record");
      expect(vendor.refreshPosts()).toBe(0);
      expect(vendor.calls).toEqual(["at_1"]);
    }, 15_000);

    it("the rejection text without a declaration is surfaced unchanged", async () => {
      const { source } = await started();

      const result = await source.execute("executeQuery", {});

      expect(result.isError).toBe(true);
      expect(result.structuredContent?.reason).not.toBe("reauth_required");
      expect(textOf(result)).toContain(REJECTION);
      expect(vendor.refreshPosts()).toBe(0);
    }, 15_000);
  });
}
