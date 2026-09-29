import type { ToolCallResponse } from "../../src/api/schemas/responses.ts";
import { readJson } from "../helpers/http.ts";
/**
 * The runtime owns the identity provider, and the server authenticates with
 * that one. So a caller the server admits is the caller the runtime's own
 * permission checks judge: a workspace member who is not its admin, and an org
 * member who is not an admin, are refused by those checks over HTTP, and the
 * admin is not. These are checks the runtime makes itself, past every gate the
 * HTTP layer applies.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ServerHandle, startServer } from "../../src/api/server.ts";
import {
  type CreateUserInput,
  type CreateUserResult,
  FIRST_PARTY_GRANT,
  type IdentityProvider,
  type ProviderCapabilities,
  type UserIdentity,
  type VerifiedIdentity,
} from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { makeTestWorkDir } from "../helpers/test-workdir.ts";

const ADMIN: UserIdentity = {
  id: "usr_ws_admin",
  email: "admin@example.com",
  displayName: "Admin",
  orgRole: "admin",
  preferences: {},
};
const MEMBER: UserIdentity = {
  id: "usr_ws_member",
  email: "member@example.com",
  displayName: "Member",
  orgRole: "member",
  preferences: {},
};
const TOKENS: Record<string, UserIdentity> = {
  "admin-token-1234567890": ADMIN,
  "member-token-1234567890": MEMBER,
};

class TokenAuthAdapter implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
    authorizationServer: false,
  };
  async verifyRequest(req: Request): Promise<VerifiedIdentity | null> {
    const who = TOKENS[req.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""];
    return who ? { ...who, grant: FIRST_PARTY_GRANT } : null;
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

describe("the server authenticates with the runtime's identity provider", () => {
  const { workDir, cleanup } = makeTestWorkDir("one-owner");
  const provider = new TokenAuthAdapter();
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;
  let wsId: string;

  beforeAll(async () => {
    runtime = await Runtime.start({
      identityProvider: () => provider,
      model: { provider: "custom", adapter: createEchoModel() },
      logging: { disabled: true },
      workDir,
    });
    const store = runtime.getWorkspaceStore();
    wsId = (await store.create("Shared")).id;
    await store.addMember(wsId, ADMIN.id, "admin");
    await store.addMember(wsId, MEMBER.id, "member");
    await runtime.ensureWorkspaceRegistry(wsId);
    handle = startServer({ runtime, port: 0 });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    cleanup();
  });

  async function callTool(
    who: UserIdentity,
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; content?: { text?: string }[] }> {
    const token = Object.keys(TOKENS).find((t) => TOKENS[t] === who);
    const res = await fetch(`${baseUrl}/v1/workspaces/${wsId}/tools/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ server, tool, arguments: args }),
    });
    expect(res.status).toBe(200);
    return await readJson<ToolCallResponse>(res);
  }

  it("is the one provider: the runtime holds it and the server admits nothing else", async () => {
    expect(runtime.getIdentityProvider()).toBe(provider);
    const res = await fetch(`${baseUrl}/v1/bootstrap`);
    expect(res.status).toBe(401);
  });

  it("refuses a workspace member's write to the workspace instructions, and admits the admin's", async () => {
    const refused = await callTool(MEMBER, "instructions", "write_instructions", {
      body: "from a member",
    });
    expect(refused.isError).toBe(true);

    const admitted = await callTool(ADMIN, "instructions", "write_instructions", {
      body: "from the admin",
    });
    expect(admitted.isError).toBe(false);
  });

  it("refuses an org member's org-wide usage report, and admits an org admin's", async () => {
    const refused = await callTool(MEMBER, "usage", "report", { scope: "org" });
    expect(refused.isError).toBe(true);
    expect(refused.content?.[0]?.text).toContain("Org-scope usage requires org admin or owner");

    const admitted = await callTool(ADMIN, "usage", "report", { scope: "org" });
    expect(admitted.isError).toBe(false);
  });
});
