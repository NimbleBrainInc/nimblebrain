#!/usr/bin/env bun
/**
 * Mock OAuth Authorization Server + MCP server, all in one process.
 * Used for end-to-end testing of the interactive OAuth flow.
 *
 * Implements just enough of:
 *   - OAuth 2.1 metadata discovery (RFC 8414)
 *   - Dynamic Client Registration (RFC 7591)
 *   - Authorization code + PKCE flow with a real consent page
 *   - Token endpoint
 *   - Streamable HTTP MCP server with one mock tool
 *
 * The /authorize endpoint returns an HTML "Continue" page rather than
 * auto-redirecting — this is what makes the flow *interactive* from the
 * provider's perspective (the redirect probe sees a 200, not a 302).
 *
 * Run with: bun run test/scripts/mock-oauth-mcp-server.ts
 * Default port: 19999
 */

import { randomBytes } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 19999);
const ORIGIN = `http://localhost:${PORT}`;

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

interface PendingAuthRequest {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
}

interface IssuedCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  consumed: boolean;
}

const clients = new Map<string, RegisteredClient>();
const pending = new Map<string, PendingAuthRequest>();
const codes = new Map<string, IssuedCode>();

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── OAuth 2.1 metadata ──────────────────────────────────────────
    if (path === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }

    // Some MCP clients probe the resource metadata path (RFC 9728).
    if (path === "/.well-known/oauth-protected-resource") {
      return json({
        resource: ORIGIN,
        authorization_servers: [ORIGIN],
      });
    }

    // ── Dynamic Client Registration ────────────────────────────────
    if (path === "/register" && req.method === "POST") {
      const body = (await req.json()) as { redirect_uris?: string[]; client_name?: string };
      const client_id = `mock-client-${randomBytes(6).toString("hex")}`;
      const client: RegisteredClient = {
        client_id,
        redirect_uris: body.redirect_uris ?? [],
        client_name: body.client_name,
      };
      clients.set(client_id, client);
      console.error(`[mock] DCR: registered ${client_id} for "${client.client_name}"`);
      return json({
        client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirect_uris,
        client_name: client.client_name,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    }

    // ── Authorize (interactive — returns a real Continue page) ─────
    if (path === "/authorize" && req.method === "GET") {
      const client_id = url.searchParams.get("client_id") ?? "";
      const redirect_uri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const code_challenge = url.searchParams.get("code_challenge") ?? "";
      const code_challenge_method = url.searchParams.get("code_challenge_method") ?? "";
      if (!clients.has(client_id)) {
        return html(`<html><body><h3>Unknown client_id: ${client_id}</h3></body></html>`, 400);
      }
      const pendingId = randomBytes(16).toString("base64url");
      pending.set(pendingId, {
        client_id,
        redirect_uri,
        state,
        code_challenge,
        code_challenge_method,
      });

      // The KEY thing: this returns a 200 HTML page, NOT a 302. That's
      // what makes the provider's redirect-probe fall through to the
      // interactive branch — the same shape Granola/Notion/HubSpot use.
      return html(`
        <!doctype html>
        <html>
          <head><title>Mock Granola — Authorize NimbleBrain</title>
            <style>
              body { font-family: system-ui; max-width: 480px; margin: 60px auto; padding: 20px; line-height: 1.5; color: #111; }
              h1 { color: #4f46e5; }
              .scope { background: #f3f4f6; padding: 12px; border-radius: 6px; margin: 16px 0; font-size: 14px; }
              button { background: #4f46e5; color: white; padding: 10px 24px; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; }
              button:hover { background: #4338ca; }
            </style>
          </head>
          <body>
            <h1>Authorize "NimbleBrain" to access your Mock Granola</h1>
            <p>NimbleBrain is requesting access to:</p>
            <div class="scope">Read your meeting notes (last 30 days)</div>
            <form method="POST" action="/authorize/approve">
              <input type="hidden" name="pending_id" value="${pendingId}">
              <button type="submit">Continue as Test User</button>
            </form>
            <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">This is a mock OAuth server for end-to-end testing of NimbleBrain's interactive OAuth flow.</p>
          </body>
        </html>
      `);
    }

    // ── Authorize approval — redirects back to client's callback ──
    if (path === "/authorize/approve" && req.method === "POST") {
      const form = await req.formData();
      const pendingId = form.get("pending_id")?.toString() ?? "";
      const p = pending.get(pendingId);
      if (!p) return html("<h3>Unknown pending request</h3>", 400);
      pending.delete(pendingId);

      const code = `mock-code-${randomBytes(8).toString("hex")}`;
      codes.set(code, {
        client_id: p.client_id,
        redirect_uri: p.redirect_uri,
        code_challenge: p.code_challenge,
        consumed: false,
      });

      const redirect = new URL(p.redirect_uri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", p.state);
      console.error(`[mock] approve: redirecting to ${redirect.toString().slice(0, 80)}…`);
      return new Response(null, {
        status: 302,
        headers: { Location: redirect.toString() },
      });
    }

    // ── Token endpoint ──────────────────────────────────────────────
    if (path === "/token" && req.method === "POST") {
      const ct = req.headers.get("content-type") ?? "";
      let params: URLSearchParams;
      if (ct.includes("application/x-www-form-urlencoded")) {
        params = new URLSearchParams(await req.text());
      } else if (ct.includes("application/json")) {
        const j = (await req.json()) as Record<string, string>;
        params = new URLSearchParams(j);
      } else {
        return json({ error: "invalid_request" }, 400);
      }
      const grant = params.get("grant_type");
      if (grant === "authorization_code") {
        const code = params.get("code") ?? "";
        const issued = codes.get(code);
        if (!issued || issued.consumed) {
          return json({ error: "invalid_grant" }, 400);
        }
        issued.consumed = true;
        // (We don't actually verify PKCE here — the mock trusts the client.)
        const access_token = `mock-access-${randomBytes(16).toString("hex")}`;
        const refresh_token = `mock-refresh-${randomBytes(16).toString("hex")}`;
        return json({
          access_token,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token,
          scope: "mock.read",
        });
      }
      if (grant === "refresh_token") {
        const access_token = `mock-access-${randomBytes(16).toString("hex")}`;
        const refresh_token = `mock-refresh-${randomBytes(16).toString("hex")}`;
        return json({
          access_token,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token,
        });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }

    // ── MCP server (Streamable HTTP) ────────────────────────────────
    if (path === "/mcp") {
      // Auth check — provider attaches Authorization: Bearer <access_token>.
      const authz = req.headers.get("authorization") ?? "";
      if (!authz.startsWith("Bearer mock-access-")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer realm="${ORIGIN}", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`,
          },
        });
      }
      if (req.method === "POST") {
        const msg = (await req.json()) as { id?: number | string; method?: string; params?: unknown };
        if (msg.method === "initialize") {
          return json({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "mock-granola", version: "0.0.1" },
            },
          });
        }
        if (msg.method === "tools/list") {
          return json({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "list_meetings",
                  description: "List recent meeting notes from your Mock Granola.",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
            },
          });
        }
        if (msg.method === "tools/call") {
          const params = msg.params as { name?: string };
          if (params?.name === "list_meetings") {
            return json({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [
                  { type: "text", text: "Mock: 3 meetings in the last 7 days." },
                ],
                isError: false,
              },
            });
          }
        }
        if (msg.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
      }
      if (req.method === "GET") {
        // No SSE stream needed for this mock; reply 405.
        return new Response(null, { status: 405 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.error(`[mock] OAuth + MCP server listening on ${ORIGIN}`);
console.error(`[mock]   metadata:    ${ORIGIN}/.well-known/oauth-authorization-server`);
console.error(`[mock]   register:    POST ${ORIGIN}/register`);
console.error(`[mock]   authorize:   GET ${ORIGIN}/authorize`);
console.error(`[mock]   token:       POST ${ORIGIN}/token`);
console.error(`[mock]   mcp:         POST ${ORIGIN}/mcp`);
console.error(``);
console.error(`To test, add this to your workspace.json bundles:`);
console.error(`  { "url": "${ORIGIN}/mcp", "serverName": "mock-granola" }`);
console.error(`then start NimbleBrain with NB_API_URL=http://localhost:27247.`);

// Keep process alive
process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
