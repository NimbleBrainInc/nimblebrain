/**
 * The chat surface reads its config by two routes, and they have to agree.
 *
 * `/v1/bootstrap` is the one that runs: the web client only calls `get_config`
 * when it was given no bootstrap, and it is always given one. So a field added
 * to `get_config` alone reaches the client as `undefined` forever — the
 * composer's model control read an empty catalog and rendered nothing at all,
 * while every unit test that mounted the control directly stayed green.
 *
 * These assert the two payloads agree rather than that either contains a named
 * field, so the next field the chat surface needs is covered without editing
 * this file.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  CreateUserInput,
  CreateUserResult,
  IdentityProvider,
  ProviderCapabilities,
  UserIdentity,
} from "../../src/identity/provider.ts";
import type { User } from "../../src/identity/user.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { runWithRequestContext } from "../../src/runtime/request-context.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createCoreToolDefs } from "../../src/tools/core-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

/** A model nobody's org default would land on, so a tint is visible. */
const CHOSEN = "anthropic:claude-opus-4-6";

const PICKY: UserIdentity = {
  id: "usr_picky",
  email: "picky@example.com",
  displayName: "Picky",
  orgRole: "member",
  preferences: { models: { default: CHOSEN } },
};

class TokenAuthAdapter implements IdentityProvider {
  readonly capabilities: ProviderCapabilities = {
    authCodeFlow: false,
    tokenRefresh: false,
    managedUsers: false,
    authorizationServer: false,
  };
  constructor(private readonly tokens: Record<string, UserIdentity>) {}
  async verifyRequest(req: Request): Promise<UserIdentity | null> {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    return this.tokens[authHeader.slice(7)] ?? null;
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

interface ComposerConfig {
  newConversationModel?: string;
  availableModels?: Record<string, { id: string }[]>;
}

describe("the two config routes agree", () => {
  const TOKEN = "picky-token-1234567890";
  const workDir = join(tmpdir(), `nb-bootstrap-composer-${Date.now()}`);
  let runtime: Runtime;
  let handle: ServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    mkdirSync(workDir, { recursive: true });
    runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      models: { default: "anthropic:claude-sonnet-5", fast: "anthropic:claude-sonnet-5" },
      providers: { anthropic: { apiKey: "k" } },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });

    const userDir = join(workDir, "users", PICKY.id);
    mkdirSync(userDir, { recursive: true });
    const now = new Date().toISOString();
    await Bun.write(
      join(userDir, "profile.json"),
      `${JSON.stringify({ ...PICKY, createdAt: now, updatedAt: now }, null, 2)}\n`,
    );

    const wsStore = runtime.getWorkspaceStore();
    const ws = await wsStore.create("Picky WS", "picky_ws");
    await wsStore.addMember(ws.id, PICKY.id, "admin");

    handle = startServer({
      runtime,
      port: 0,
      provider: new TokenAuthAdapter({ [TOKEN]: PICKY }),
    });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    handle?.stop(true);
    await runtime?.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  });

  async function fromBootstrap(): Promise<ComposerConfig> {
    const res = await fetch(`${baseUrl}/v1/bootstrap`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { config: ComposerConfig }).config;
  }

  async function fromGetConfig(): Promise<ComposerConfig> {
    const tool = createCoreToolDefs(runtime).find((d) => d.name === "get_config");
    if (!tool) throw new Error("get_config not found");
    return runWithRequestContext(
      { identity: PICKY, workspaceId: null } as never,
      async () => (await tool.handler({})).structuredContent as ComposerConfig,
    );
  }

  test("both name the same model for the next conversation", async () => {
    const [boot, cfg] = await Promise.all([fromBootstrap(), fromGetConfig()]);
    // Tinted by the caller's preference on both routes: the value is what the
    // pin will be, so a route reporting the org default would name a model the
    // conversation is about to contradict.
    expect(boot.newConversationModel).toBe(CHOSEN);
    expect(boot.newConversationModel).toBe(cfg.newConversationModel);
  });

  test("both offer the same models to choose from", async () => {
    const [boot, cfg] = await Promise.all([fromBootstrap(), fromGetConfig()]);
    const ids = (c: ComposerConfig) =>
      Object.entries(c.availableModels ?? {})
        .flatMap(([provider, ms]) => ms.map((m) => `${provider}:${m.id}`))
        .sort();

    // Non-empty is half the assertion: an empty catalog is exactly what the
    // client saw when this field reached it by one route only, and it renders
    // as a control that silently isn't there.
    expect(ids(boot).length).toBeGreaterThan(0);
    expect(ids(boot)).toEqual(ids(cfg));
  });
});
