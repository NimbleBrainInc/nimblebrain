import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import {
  type AuthMode,
  authenticateRequest,
  isAuthError,
  resolveAuthMode,
} from "../../../src/api/auth-middleware.ts";
import type {
  IdentityProvider,
  UserIdentity,
  CreateUserResult,
} from "../../../src/identity/provider.ts";
import type { OrgRole } from "../../../src/identity/types.ts";
import type { User } from "../../../src/identity/user.ts";

const noopSink = new NoopEventSink();

// ── Test helpers ──────────────────────────────────────────────────

const TEST_INTERNAL_TOKEN = "internal-token-for-testing-12345";

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
    },
    async verifyRequest(req: Request): Promise<UserIdentity | null> {
      const auth = req.headers.get("authorization");
      if (auth === `Bearer ${validToken}`) {
        return identity;
      }
      // Also check session cookie
      const cookie = req.headers.get("cookie") ?? "";
      for (const pair of cookie.split(";")) {
        const [name, ...rest] = pair.trim().split("=");
        if (name === "nb_session" && rest.join("=") === "valid-session") {
          return identity;
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

// ── resolveAuthMode ───────────────────────────────────────────────

describe("resolveAuthMode", () => {
  it("returns adapter mode when provider is provided", () => {
    const provider = createMockProvider("key", makeIdentity());
    const mode = resolveAuthMode(provider);
    expect(mode.type).toBe("adapter");
  });

  it("returns dev mode when no provider is provided", () => {
    const mode = resolveAuthMode(null);
    expect(mode.type).toBe("dev");
  });
});

// ── Dev mode ──────────────────────────────────────────────────────

describe("authenticateRequest — dev mode", () => {
  const options = {
    mode: { type: "dev" } as AuthMode,
    internalToken: TEST_INTERNAL_TOKEN,
    eventSink: noopSink,
  };

  it("allows unauthenticated requests", async () => {
    const req = makeRequest("/v1/chat", { method: "POST" });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(false);
  });

  it("returns undefined identity in dev mode", async () => {
    const req = makeRequest("/v1/shell");
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(false);
    if (!isAuthError(result)) {
      expect(result.identity).toBeUndefined();
    }
  });
});

// ── Adapter mode ──────────────────────────────────────────────────

describe("authenticateRequest — adapter mode", () => {
  const identity = makeIdentity();
  const validAdapterKey = "adapter-valid-key-123456";
  const provider = createMockProvider(validAdapterKey, identity);

  const options = {
    mode: { type: "adapter", provider } as AuthMode,
    internalToken: TEST_INTERNAL_TOKEN,
    eventSink: noopSink,
  };

  it("accepts valid Bearer token and returns identity", async () => {
    const req = makeRequest("/v1/shell", {
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
    const req = makeRequest("/v1/shell", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
    }
  });

  it("accepts valid session cookie via adapter", async () => {
    const req = makeRequest("/v1/shell", {
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
    const req = makeRequest("/v1/shell");
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(401);
    }
  });

  it("does not leak user existence info in 401 response", async () => {
    const req = makeRequest("/v1/shell", {
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

// ── Internal token ────────────────────────────────────────────────

describe("authenticateRequest — internal token", () => {
  const provider = createMockProvider("some-key", makeIdentity());
  const options = {
    mode: { type: "adapter", provider } as AuthMode,
    internalToken: TEST_INTERNAL_TOKEN,
    eventSink: noopSink,
  };

  it("allows internal token on POST /v1/chat", async () => {
    const req = makeRequest("/v1/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_INTERNAL_TOKEN}` },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(false);
  });

  it("allows internal token on POST /v1/chat/stream", async () => {
    const req = makeRequest("/v1/chat/stream", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_INTERNAL_TOKEN}` },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(false);
  });

  it("rejects internal token on non-chat endpoints with 403", async () => {
    const req = makeRequest("/v1/shell", {
      headers: { Authorization: `Bearer ${TEST_INTERNAL_TOKEN}` },
    });
    const result = await authenticateRequest(req, options);
    expect(isAuthError(result)).toBe(true);
    if (isAuthError(result)) {
      expect(result.status).toBe(403);
    }
  });

  it("internal token works even in dev mode", async () => {
    const devOptions = {
      mode: { type: "dev" } as AuthMode,
      internalToken: TEST_INTERNAL_TOKEN,
    };
    const req = makeRequest("/v1/chat", {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_INTERNAL_TOKEN}` },
    });
    const result = await authenticateRequest(req, devOptions);
    expect(isAuthError(result)).toBe(false);
  });
});

// ── authenticateRequest returns identity ──────────────────────────

describe("authenticateRequest — identity in return value", () => {
  it("returns identity after successful adapter auth", async () => {
    const identity = makeIdentity({ email: "identity-test@example.com" });
    const provider = createMockProvider("my-key", identity);
    const options = {
      mode: { type: "adapter", provider } as AuthMode,
      internalToken: TEST_INTERNAL_TOKEN,
    };

    const req = makeRequest("/v1/shell", {
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
      mode: { type: "adapter", provider: provider1 } as AuthMode,
      internalToken: TEST_INTERNAL_TOKEN,
    };
    const options2 = {
      mode: { type: "adapter", provider: provider2 } as AuthMode,
      internalToken: TEST_INTERNAL_TOKEN,
    };

    const req1 = makeRequest("/v1/shell", {
      headers: { Authorization: "Bearer key-1" },
    });
    const req2 = makeRequest("/v1/shell", {
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
