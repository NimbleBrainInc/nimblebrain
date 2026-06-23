/**
 * Tests for the API-key Composio path:
 *   - `connectComposioApiKey` in `src/composio/sdk.ts` (the SDK helper that
 *     hands the user's key to Composio and verifies via `waitForConnection`)
 *   - `manage_connectors.connect_api_key` validation + trust boundary in
 *     `src/tools/connector-tools.ts`
 *
 * Kept separate from the OAuth install tests because this path needs the
 * `@composio/core` mock to export `AuthScheme` and to return a connection
 * request with `waitForConnection`.
 *
 * What's covered:
 *   - connectComposioApiKey forwards `fields` via `AuthScheme.APIKey`, passes
 *     allowMultiple, and returns the verified connectedAccountId + status
 *   - verification failure deletes the dangling connected account and rethrows
 *   - connect_api_key rejects unknown field keys (default-deny)
 *   - connect_api_key rejects a missing required field
 *   - connect_api_key rejects a non-API_KEY composio connector
 *   - connect_api_key surfaces an operator-config error when COMPOSIO_API_KEY
 *     is unset (i.e. field validation passed and we reached the env check)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── @composio/core mock (hoisted) ───────────────────────────────────
interface ApiKeyCalls {
  initiateArgs: unknown[];
  apiKeyParamsSeen: Record<string, string> | undefined;
  deletedIds: string[];
  initiateImpl: (...args: unknown[]) => {
    id: string;
    waitForConnection: (t?: number) => Promise<{ id: string; status: string }>;
  };
}
const apiKeyCalls: ApiKeyCalls = {
  initiateArgs: [],
  apiKeyParamsSeen: undefined,
  deletedIds: [],
  initiateImpl: () => ({
    id: "ca_default",
    waitForConnection: async () => ({ id: "ca_default", status: "ACTIVE" }),
  }),
};
mock.module("@composio/core", () => ({
  AuthScheme: {
    APIKey: (params: Record<string, string>) => {
      apiKeyCalls.apiKeyParamsSeen = params;
      return { authScheme: "API_KEY", val: { status: "ACTIVE", ...params } };
    },
  },
  Composio: class {
    connectedAccounts = {
      list: async () => ({ items: [] }),
      initiate: (...args: unknown[]) => {
        apiKeyCalls.initiateArgs = args;
        return apiKeyCalls.initiateImpl(...args);
      },
      delete: async (id: string) => {
        apiKeyCalls.deletedIds.push(id);
      },
    };
    create() {
      return { mcp: { type: "http", url: "https://composio.test/mcp/x", headers: {} } };
    }
    constructor(_opts: unknown) {}
  },
}));

import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { _resetComposioConfigForTest, connectComposioApiKey } from "../../src/composio/sdk.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import { ConnectorDirectory } from "../../src/registries/directory.ts";
import { RegistryStore } from "../../src/registries/registry-store.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import {
  createManageConnectorsTool,
  type ManageConnectorsContext,
} from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const POSTHOG_ID = "com.posthog/analytics";
const GMAIL_ID = "com.google/gmail";

// Catalog with one API_KEY connector (posthog) and one OAUTH2-default
// connector (gmail, no authScheme) so the non-API_KEY rejection is covered.
const CATALOG_YAML = `servers:
  - name: ${POSTHOG_ID}
    title: PostHog
    description: Product analytics (via Composio)
    version: "0.1.0"
    remotes:
      - type: streamable-http
        url: https://backend.composio.dev/v3/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: composio
        composio:
          toolkit: posthog
          authConfigEnv: COMPOSIO_POSTHOG_AUTH_CONFIG_ID
          authScheme: API_KEY
          fields:
            - key: api_key
              title: API Key
              sensitive: true
              required: true
            - key: subdomain
              title: Region
              required: true
        tags: [analytics]
  - name: ${GMAIL_ID}
    title: Gmail
    description: Mail (via Composio)
    version: "0.1.0"
    remotes:
      - type: streamable-http
        url: https://backend.composio.dev/v3/mcp
    _meta:
      ai.nimblebrain/connector:
        auth: composio
        composio:
          toolkit: gmail
          authConfigEnv: COMPOSIO_GMAIL_AUTH_CONFIG_ID
        tags: [email]
`;

const ADMIN: UserIdentity = {
  id: "usr_admin",
  email: "admin@test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

interface Harness {
  workDir: string;
  wsId: string;
  runtime: Runtime;
}

function buildHarness(): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-composio-apikey-"));
  const wsId = "ws_test";
  const workspaceStore = new WorkspaceStore(workDir);
  const catalogPath = join(workDir, "catalog.yaml");
  writeFileSync(catalogPath, CATALOG_YAML);
  writeFileSync(
    join(workDir, "registries.json"),
    JSON.stringify({
      registries: [
        {
          id: "bundled-static",
          name: "Curated",
          type: "static",
          enabled: true,
          locked: true,
          url: catalogPath,
        },
        { id: "mpak", name: "mpak", type: "mpak", enabled: false },
      ],
    }),
  );
  const registryStore = new RegistryStore(workDir);
  const lifecycle = new BundleLifecycleManager(new NoopEventSink(), undefined);
  const workspaceRegistry = new ToolRegistry();

  const runtime = {
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getRegistryStore: () => registryStore,
    getConnectorDirectory: () => new ConnectorDirectory(registryStore),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: () => workspaceRegistry,
    getAllowInsecureRemotes: () => false,
    getEventSink: () => new NoopEventSink(),
    getBundleInstancesForWorkspace: () => lifecycle.getInstances(),
  } as unknown as Runtime;

  return { workDir, wsId, runtime };
}

async function provision(h: Harness): Promise<void> {
  const store = h.runtime.getWorkspaceStore();
  await store.create("Test", h.wsId.slice(3));
  await store.addMember(h.wsId, ADMIN.id, "admin");
}

function buildTool(h: Harness) {
  const ctx: ManageConnectorsContext = {
    runtime: h.runtime,
    getIdentity: () => ADMIN,
    getWorkspaceId: () => h.wsId,
  };
  return createManageConnectorsTool(ctx);
}

const TRACKED_ENV = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_POSTHOG_AUTH_CONFIG_ID",
  "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
  "NB_TENANT_ID",
];
const SAVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TRACKED_ENV) SAVED_ENV[k] = process.env[k];
  for (const k of TRACKED_ENV) delete process.env[k];
  _resetComposioConfigForTest();
  apiKeyCalls.initiateArgs = [];
  apiKeyCalls.apiKeyParamsSeen = undefined;
  apiKeyCalls.deletedIds = [];
  apiKeyCalls.initiateImpl = () => ({
    id: "ca_default",
    waitForConnection: async () => ({ id: "ca_default", status: "ACTIVE" }),
  });
});

afterEach(() => {
  for (const k of TRACKED_ENV) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  _resetComposioConfigForTest();
});

// ── connectComposioApiKey (SDK) ─────────────────────────────────────

describe("connectComposioApiKey", () => {
  test("forwards fields via AuthScheme.APIKey and returns the verified account", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    _resetComposioConfigForTest();
    apiKeyCalls.initiateImpl = () => ({
      id: "ca_new",
      waitForConnection: async () => ({ id: "ca_new", status: "ACTIVE" }),
    });

    const res = await connectComposioApiKey({
      apiKey: "k_test",
      userId: "u1",
      authConfigId: "ac_posthog",
      fields: { api_key: "phx_secret", subdomain: "us" },
    });

    expect(res).toEqual({ connectedAccountId: "ca_new", status: "ACTIVE" });
    // The submitted values were handed to AuthScheme.APIKey verbatim.
    expect(apiKeyCalls.apiKeyParamsSeen).toEqual({ api_key: "phx_secret", subdomain: "us" });
    // initiate(userId, authConfigId, { config, allowMultiple }).
    expect(apiKeyCalls.initiateArgs[0]).toBe("u1");
    expect(apiKeyCalls.initiateArgs[1]).toBe("ac_posthog");
    const opts = apiKeyCalls.initiateArgs[2] as { allowMultiple?: boolean; config?: unknown };
    expect(opts.allowMultiple).toBe(true);
    expect(opts.config).toEqual({
      authScheme: "API_KEY",
      val: { status: "ACTIVE", api_key: "phx_secret", subdomain: "us" },
    });
  });

  test("deletes the dangling account and rethrows when verification fails", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    _resetComposioConfigForTest();
    apiKeyCalls.initiateImpl = () => ({
      id: "ca_bad",
      waitForConnection: async () => {
        throw new Error("Connection request failed with status: FAILED");
      },
    });

    await expect(
      connectComposioApiKey({
        apiKey: "k_test",
        userId: "u1",
        authConfigId: "ac_x",
        fields: { api_key: "bad-key" },
      }),
    ).rejects.toThrow(/FAILED/);

    // The half-created account is cleaned up so a retry starts clean.
    expect(apiKeyCalls.deletedIds).toContain("ca_bad");
  });
});

// ── manage_connectors.connect_api_key (validation + trust) ──────────

describe("manage_connectors.connect_api_key", () => {
  let h: Harness;

  beforeEach(async () => {
    h = buildHarness();
    await provision(h);
  });

  afterEach(() => {
    rmSync(h.workDir, { recursive: true, force: true });
  });

  test("rejects an unknown field key (default-deny)", async () => {
    const tool = buildTool(h);
    const r = await tool.handler({
      action: "connect_api_key",
      catalogId: POSTHOG_ID,
      fields: { api_key: "x", subdomain: "us", bogus: "y" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("Unknown field");
    expect(JSON.stringify(r)).toContain("bogus");
    // Never reached Composio.
    expect(apiKeyCalls.initiateArgs.length).toBe(0);
  });

  test("rejects a missing required field", async () => {
    const tool = buildTool(h);
    const r = await tool.handler({
      action: "connect_api_key",
      catalogId: POSTHOG_ID,
      fields: { subdomain: "us" }, // api_key missing
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("api_key");
    expect(apiKeyCalls.initiateArgs.length).toBe(0);
  });

  test("rejects a non-API_KEY composio connector", async () => {
    const tool = buildTool(h);
    const r = await tool.handler({
      action: "connect_api_key",
      catalogId: GMAIL_ID, // authScheme defaults to OAUTH2
      fields: { api_key: "x" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("does not use API-key auth");
    expect(apiKeyCalls.initiateArgs.length).toBe(0);
  });

  test("surfaces an operator-config error when COMPOSIO_API_KEY is unset", async () => {
    // Valid fields → field validation passes → reaches the env check.
    const tool = buildTool(h);
    const r = await tool.handler({
      action: "connect_api_key",
      catalogId: POSTHOG_ID,
      fields: { api_key: "phx_secret", subdomain: "us" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain("COMPOSIO_API_KEY");
    expect(apiKeyCalls.initiateArgs.length).toBe(0);
  });
});
