import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  UserIdentity,
} from "../../../src/identity/provider.ts";
import type { User } from "../../../src/identity/user.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { startServer } from "../../../src/api/server.ts";
import type { ServerHandle } from "../../../src/api/server.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

/**
 * Integration tests for per-identity request rate limiting on the chat,
 * tool-call, and `/mcp` surfaces. Uses a dedicated server with low limits
 * (3 each) to verify:
 * - 429 when a surface's limit is exceeded
 * - rate limiting doesn't bleed to unrelated endpoints
 * - correct error shape and Retry-After header
 *
 * Rate limiting is an authenticated-mode control — it's bypassed entirely in
 * dev mode (no real identity provider). So this server is started WITH a
 * provider. The adapter authenticates as `usr_default` (the same id
 * `provisionTestWorkspace` adds as a member of the test workspace) so the
 * workspace-scoped calls pass membership and actually reach the limiter.
 */

const TOKEN = "rate-limit-test-token-abcdef";
const IDENTITY: UserIdentity = {
  id: DEV_IDENTITY.id,
  email: "ratelimit@example.test",
  displayName: "Rate Limit Tester",
  orgRole: "member",
};

class TokenAuthAdapter implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
  };
  async verifyRequest(req: Request): Promise<UserIdentity | null> {
    const auth = req.headers.get("authorization");
    if (!auth?.startsWith("Bearer ")) return null;
    return auth.slice(7) === TOKEN ? IDENTITY : null;
  }
  async listUsers(): Promise<User[]> {
    return [];
  }
  async createUser(_data: CreateUserInput): Promise<CreateUserResult> {
    throw new Error("not supported");
  }
  async deleteUser(): Promise<boolean> {
    return false;
  }
}

const authHeaders = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
  ...extra,
});

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-rate-limit-${Date.now()}`);

// Set low limits so tests can exhaust them quickly
const originalChatLimit = process.env.NB_CHAT_RATE_LIMIT;
const originalToolLimit = process.env.NB_TOOL_RATE_LIMIT;
const originalMcpLimit = process.env.NB_MCP_RATE_LIMIT;

beforeAll(async () => {
  process.env.NB_CHAT_RATE_LIMIT = "3";
  process.env.NB_TOOL_RATE_LIMIT = "3";
  process.env.NB_MCP_RATE_LIMIT = "3";

  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });

  await provisionTestWorkspace(runtime);

  // WITH a provider → not dev mode → rate limiting is active.
  handle = startServer({ runtime, port: 0, provider: new TokenAuthAdapter() });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  rmSync(testDir, { recursive: true, force: true });

  // Restore env
  for (const [key, original] of [
    ["NB_CHAT_RATE_LIMIT", originalChatLimit],
    ["NB_TOOL_RATE_LIMIT", originalToolLimit],
    ["NB_MCP_RATE_LIMIT", originalMcpLimit],
  ] as const) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("chat rate limiting", () => {
  it("returns 429 after exceeding chat limit", async () => {
    // Exhaust the limit
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/v1/chat`, {
        method: "POST",
        headers: authHeaders({ "X-Workspace-Id": TEST_WORKSPACE_ID }),
        body: JSON.stringify({ message: `msg ${i}`, workspaceId: TEST_WORKSPACE_ID }),
      });
      expect(res.status).toBe(200);
    }

    // Next request should be rate-limited
    const res = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: authHeaders({ "X-Workspace-Id": TEST_WORKSPACE_ID }),
      body: JSON.stringify({ message: "over limit", workspaceId: TEST_WORKSPACE_ID }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
    expect(body.message).toBe("Rate limit exceeded");
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("does not rate-limit unrelated endpoints when chat is exhausted", async () => {
    // Chat is already exhausted from the previous test.
    // Health endpoint should still work.
    const healthRes = await fetch(`${baseUrl}/v1/health`);
    expect(healthRes.status).toBe(200);
  });
});

describe("tool-call rate limiting", () => {
  it("returns 429 after exceeding tool-call limit", async () => {
    // Exhaust the limit — these return 400/404 but still count
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/v1/tools/call`, {
        method: "POST",
        headers: authHeaders({ "X-Workspace-Id": TEST_WORKSPACE_ID }),
        body: JSON.stringify({ server: "x", tool: "y", arguments: {} }),
      });
    }

    const res = await fetch(`${baseUrl}/v1/tools/call`, {
      method: "POST",
      headers: authHeaders({ "X-Workspace-Id": TEST_WORKSPACE_ID }),
      body: JSON.stringify({ server: "x", tool: "y", arguments: {} }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });

  it("does not rate-limit shell or file endpoints when tools/call is exhausted", async () => {
    // tools/call is exhausted, but /v1/shell should still work
    const shellRes = await fetch(`${baseUrl}/v1/shell`, {
      headers: authHeaders({ "X-Workspace-Id": TEST_WORKSPACE_ID }),
    });
    expect(shellRes.status).toBe(200);
  });
});

describe("mcp rate limiting", () => {
  it("returns 429 after exceeding the /mcp limit", async () => {
    // Authenticated POSTs to /mcp. The body isn't a valid initialize, so the
    // handler errors — but the limiter runs before the handler, so each call
    // still counts (same as the tool-call test counts 400s).
    for (let i = 0; i < 3; i++) {
      await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders({ Accept: "application/json, text/event-stream" }),
        body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" }),
      });
    }

    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: authHeaders({ Accept: "application/json, text/event-stream" }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("rate_limited");
  });
});
