import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { authenticateRequest, isAuthError } from "../../../src/api/auth-middleware.ts";
import {
  type CreateUserResult,
  FIRST_PARTY_GRANT,
  type IdentityProvider,
  type UserIdentity,
  type VerifiedIdentity,
} from "../../../src/identity/provider.ts";
import type { OrgRole } from "../../../src/identity/types.ts";
import type { User } from "../../../src/identity/user.ts";

const noopSink = new NoopEventSink();

// ── Test helpers ──────────────────────────────────────────────────

function makeIdentity(overrides?: Partial<UserIdentity>): UserIdentity {
  return {
    id: "usr_abc123",
    email: "test@example.com",
    displayName: "Test User",
    orgRole: "admin" as OrgRole,
    ...overrides,
  };
}

/** A mock IdentityProvider that returns a fixed identity for a specific Bearer token. */
function createMockProvider(validToken: string, identity: UserIdentity): IdentityProvider {
  return {
    capabilities: {
      authCodeFlow: false,
      tokenRefresh: false,
      managedUsers: false,
      authorizationServer: false,
    },
    async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
      const auth = req.headers.get("authorization");
      if (auth === `Bearer ${validToken}`) {
        return { ...identity, grant: FIRST_PARTY_GRANT };
      }
      // Also check session cookie
      const cookie = req.headers.get("cookie") ?? "";
      for (const pair of cookie.split(";")) {
        const [name, ...rest] = pair.trim().split("=");
        if (name === "nb_session" && rest.join("=") === "valid-session") {
          return { ...identity, grant: FIRST_PARTY_GRANT };
        }
      }
      return null;
    },
    async listUsers(): Promise<User[]> {
      return [];
    },
    async createUser(): Promise<CreateUserResult> {
      throw new Error("Not implemented in mock");
    },
    async deleteUser(): Promise<boolean> {
      return false;
    },
  };
}

function makeRequest(
  path: string,
  options?: { method?: string; headers?: Record<string, string> },
): Request {
  const method = options?.method ?? "GET";
  return new Request(`http://localhost:27247${path}`, {
    method,
    headers: options?.headers,
  });
}

// ── Adapter mode ──────────────────────────────────────────────────

describe("authenticateRequest — adapter mode", () => {
  const identity = makeIdentity();
  const validAdapterKey = "adapter-valid-key-123456";
  const provider = createMockProvider(validAdapterKey, identity);

  const options = {
    provider,
    eventSink: noopSink,
  };

  it("accepts valid Bearer token and returns identity", async () => {
    const req = makeRequest("/v1/workspaces/ws_a/shell", {
      headers: { Authorization: `Bearer ${validAdapterKey}` },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(false);

    if (!isAuthError(result)) {
      expect(result.identity).toBeDefined();
      expect(result.identity!.id).toBe("usr_abc123");
      expect(result.identity!.email).toBe("test@example.com");
    }
  });

  it("rejects invalid Bearer token with 401", async () => {
    const req = makeRequest("/v1/workspaces/ws_a/shell", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
    }
  });

  it("rejects an unverified Bearer token on a workspace's chat route with 401", async () => {
    const req = makeRequest("/v1/workspaces/ws_a/chat", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-provider-token" },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
    }
  });

  it("accepts valid session cookie via adapter", async () => {
    const req = makeRequest("/v1/workspaces/ws_a/shell", {
      headers: { Cookie: "nb_session=valid-session" },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(false);

    if (!isAuthError(result)) {
      expect(result.identity).toBeDefined();
      expect(result.identity!.id).toBe("usr_abc123");
    }
  });

  it("rejects unauthenticated requests with 401", async () => {
    const req = makeRequest("/v1/workspaces/ws_a/shell");
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
    }
  });

  it("does not leak user existence info in 401 response", async () => {
    const req = makeRequest("/v1/workspaces/ws_a/shell", {
      headers: { Authorization: "Bearer bad-key" },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
      const body = await result.text();
      expect(body).toBe("");
    }
  });
});

// ── authenticateRequest returns identity ──────────────────────────

describe("authenticateRequest — identity in return value", () => {
  it("returns identity after successful adapter auth", async () => {
    const identity = makeIdentity({ email: "identity-test@example.com" });
    const provider = createMockProvider("my-key", identity);
    const options = {
      provider,
      eventSink: noopSink,
    };

    const req = makeRequest("/v1/workspaces/ws_a/shell", {
      headers: { Authorization: "Bearer my-key" },
    });
    const result = await authenticateRequest(req, options);

    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.identity).toBeDefined();
      expect(result.identity!.email).toBe("identity-test@example.com");
    }
  });

  it("different requests return independent identities", async () => {
    const identity1 = makeIdentity({ id: "usr_1", email: "one@example.com" });
    const identity2 = makeIdentity({ id: "usr_2", email: "two@example.com" });

    const provider1 = createMockProvider("key-1", identity1);
    const provider2 = createMockProvider("key-2", identity2);

    const options1 = {
      provider: provider1,
      eventSink: noopSink,
    };
    const options2 = {
      provider: provider2,
      eventSink: noopSink,
    };

    const req1 = makeRequest("/v1/workspaces/ws_a/shell", {
      headers: { Authorization: "Bearer key-1" },
    });
    const req2 = makeRequest("/v1/workspaces/ws_a/shell", {
      headers: { Authorization: "Bearer key-2" },
    });

    const result1 = await authenticateRequest(req1, options1);
    const result2 = await authenticateRequest(req2, options2);

    expect(isAuthError(result1)).toBe(false);
    expect(isAuthError(result2)).toBe(false);
    if (!isAuthError(result1) && !isAuthError(result2)) {
      expect(result1.identity!.email).toBe("one@example.com");
      expect(result2.identity!.email).toBe("two@example.com");
    }
  });
});
