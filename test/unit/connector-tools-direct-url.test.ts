/**
 * `manage_connectors install` with `kind: "direct-url"`: a server in
 * development added by its loopback URL on a local install (ADR-0065).
 *
 * Pinned here, against a stub runtime and a fake network:
 *   - the gate: refused `DIRECT_URL_NOT_ALLOWED` unless the local-install gate holds;
 *   - the URL: refused `URL_NOT_LOOPBACK` unless it names a loopback host;
 *   - the name: `NAME_TAKEN`, `NAME_IS_CATALOG_ENTRY`, and where it comes from;
 *   - the card: only its display fields and `placements` reach the stored row,
 *     never `hooks` or `adminTools` (in either spelling), and a missing card is not an error.
 *
 * A real server installed this way, its tools, a restart and an uninstall are
 * in `test/integration/direct-url-install.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import type { CatalogListing } from "../../src/connectors/catalog/types.ts";
import {
  _resetHostLoopbackForTest,
  setHostLoopbackAlias,
} from "../../src/connectors/runtime/host-loopback.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import {
  isAcceptedIconUrl,
  parseServerCard,
  SERVER_CARD_MAX_BYTES,
  SERVER_CARD_MEDIA_TYPE,
  serverCardUrl,
} from "../../src/connectors/runtime/server-card.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import type { HookReconcileDeps } from "../../src/hooks/reconcile.ts";
import type { UserIdentity } from "../../src/identity/provider.ts";
import type { LifecycleNotifyDeps } from "../../src/lifecycle/notify.ts";
import type { Runtime } from "../../src/runtime/runtime.ts";
import { createManageConnectorsTool } from "../../src/tools/connector-tools.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { ToolResult } from "../../src/tools/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import { installTestCredentialStore } from "../helpers/credential-store.ts";
import { fakeFetch } from "../helpers/fake-fetch.ts";
import { stub } from "../helpers/stub.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS = "ws_000f7ed6658f9d30";
const ALIAS = "host.docker.internal";
const SERVER_URL = "http://127.0.0.1:8000/mcp";

const ADMIN: UserIdentity = {
  id: "usr_admin_direct",
  email: "admin@example.test",
  displayName: "Admin",
  orgRole: "member",
  preferences: {},
};

const CARD = {
  name: "io.github.dev/weather",
  title: "Weather (dev)",
  description: "Forecasts, in development",
  version: "0.1.0",
  icons: [{ src: "http://10.0.0.5/icon.png" }, { src: "data:image/svg+xml;base64,PHN2Zy8+" }],
  _meta: {
    "ai.nimblebrain/host": {
      hostVersion: "1.5",
      placements: [
        {
          slot: "sidebar.apps",
          resourceUri: "ui://weather/main",
          label: "Weather",
          route: "weather",
        },
        { slot: "main", resourceUri: "ui://other/evil" },
      ],
      hooks: [{ vendor: "acme", route: "/ingest/acme", registerTool: "set_webhook_url" }],
      adminTools: ["configure"],
      recordArguments: true,
      notifications: { resource: "ui://weather/outbox" },
    },
  },
};

interface Harness {
  workDir: string;
  workspaceStore: WorkspaceStore;
  lifecycle: ConnectorLifecycleManager;
  /** URL → host header of every request the fake network saw. */
  requests: Array<{ url: string; host: string | null; accept: string | null }>;
  card: { body: unknown; status: number; headers?: Record<string, string> };
  tool: ReturnType<typeof createManageConnectorsTool>;
}

let h: Harness;
let originalFetch: typeof fetch;

function buildHarness(hostLoopback: string | null): Harness {
  const workDir = mkdtempSync(join(tmpdir(), "nb-direct-url-"));
  const workspaceStore = new WorkspaceStore(workDir);
  installTestCredentialStore(workDir);
  const lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
  const registry = new ToolRegistry();
  const runtime = stub<Runtime>({
    getWorkDir: () => workDir,
    getWorkspaceStore: () => workspaceStore,
    getConnectorCatalog: () => new ConnectorCatalog(CONNECTOR_FIXTURE_DIR),
    getLifecycle: () => lifecycle,
    getRegistryForWorkspace: () => registry,
    getEventSink: () => new NoopEventSink(),
    getConnectorMcpDeps: () => undefined,
    getHostLoopback: () => hostLoopback,
    getAllowInsecureRemotes: () => hostLoopback !== null,
    getHookReconcileDeps: () =>
      stub<HookReconcileDeps>({
        workspaceStore,
        identity: undefined,
        declarationsFor: async () => [],
        portFor: () => undefined,
      }),
    getLifecycleNotifyDeps: () =>
      stub<LifecycleNotifyDeps>({
        declarationFor: async () => undefined,
        portFor: () => undefined,
      }),
  });
  const harness: Harness = {
    workDir,
    workspaceStore,
    lifecycle,
    requests: [],
    card: { body: CARD, status: 200 },
    tool: createManageConnectorsTool({
      runtime,
      getIdentity: () => ADMIN,
      getWorkspaceId: () => WS,
    }),
  };
  return harness;
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  h = buildHarness(ALIAS);
  setHostLoopbackAlias(ALIAS);
  await seedWorkspace(h.workspaceStore, WS, { name: "Dev" });
  await h.workspaceStore.addMember(WS, ADMIN.id, "admin");
  globalThis.fetch = fakeFetch(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    h.requests.push({ url, host: headers.get("host"), accept: headers.get("accept") });
    if (url.endsWith("/server-card")) {
      return new Response(JSON.stringify(h.card.body), {
        status: h.card.status,
        headers: { "content-type": SERVER_CARD_MEDIA_TYPE, ...h.card.headers },
      });
    }
    // The MCP endpoint itself: nothing listens in a unit test.
    throw new TypeError("connect ECONNREFUSED");
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetHostLoopbackForTest();
  rmSync(h.workDir, { recursive: true, force: true });
});

function entry(url = SERVER_URL, serverName?: string): CatalogListing {
  return {
    id: "direct-url",
    name: url,
    description: "A server in development",
    install: { kind: "direct-url", url, ...(serverName ? { serverName } : {}) },
  };
}

function install(url?: string, serverName?: string): Promise<ToolResult> {
  return h.tool.handler({ action: "install", entry: entry(url, serverName) });
}

function sc(result: ToolResult): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

async function storedRows(): Promise<ConnectorRef[]> {
  return (await h.workspaceStore.get(WS))?.connectors ?? [];
}

describe("the local-install gate", () => {
  test("refuses DIRECT_URL_NOT_ALLOWED when the gate is shut, and writes nothing", async () => {
    rmSync(h.workDir, { recursive: true, force: true });
    h = buildHarness(null);
    await seedWorkspace(h.workspaceStore, WS, { name: "Dev" });
    await h.workspaceStore.addMember(WS, ADMIN.id, "admin");
    const result = await install();
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ ok: false, error: "DIRECT_URL_NOT_ALLOWED" });
    expect((result.content?.[0] as { text?: string } | undefined)?.text).toMatch(
      /only on a local install/,
    );
    expect(await storedRows()).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  test("the same URL sent as a remote-oauth entry under an id the catalog does not list is refused too", async () => {
    rmSync(h.workDir, { recursive: true, force: true });
    h = buildHarness(null);
    await seedWorkspace(h.workspaceStore, WS, { name: "Dev" });
    await h.workspaceStore.addMember(WS, ADMIN.id, "admin");
    const result = await h.tool.handler({
      action: "install",
      entry: {
        id: "example.attacker/mcp",
        name: "Looks Official",
        description: "",
        install: {
          kind: "remote-oauth",
          url: "https://mcp.attacker.example/mcp",
          transportType: "streamable-http",
          auth: "dcr",
        },
      },
    });
    expect(result.isError).toBe(true);
    expect(sc(result)).toEqual({ ok: false, error: "NOT_IN_CATALOG" });
    expect(await storedRows()).toEqual([]);
    expect(h.requests).toEqual([]);
  });
});

describe("the URL", () => {
  test.each([
    "https://mcp.example.com/mcp",
    "http://10.0.0.5:8000/mcp",
    `http://${ALIAS}:8000/mcp`,
    "http://169.254.169.254/latest",
  ])("refuses %p with URL_NOT_LOOPBACK before any request", async (url) => {
    const result = await install(url);
    expect(result.isError).toBe(true);
    expect(sc(result).error).toBe("URL_NOT_LOOPBACK");
    expect(h.requests).toEqual([]);
    expect(await storedRows()).toEqual([]);
  });

  test("refuses a URL that is not http(s) at the entry gate", async () => {
    const result = await install("file:///etc/passwd");
    expect(result.isError).toBe(true);
    expect(await storedRows()).toEqual([]);
  });
});

describe("an install with a card", () => {
  test("stores the URL as given, the card's display and placements, and no grant", async () => {
    const result = await install();
    expect(result.isError).toBe(false);
    const out = sc(result);
    expect(out.ok).toBe(true);
    expect(out.serverName).toBe("io-github-dev-weather");
    expect(out.url).toBe(SERVER_URL);
    expect(out.dialed).toBe(`http://${ALIAS}:8000/mcp`);
    expect(out.wsId).toBe(WS);
    expect(out.placements).toEqual([
      {
        slot: "sidebar.apps",
        resourceUri: "ui://weather/main",
        label: "Weather",
        route: "weather",
      },
    ]);
    // The connection never came up in a unit test; the install still succeeded.
    expect(typeof out.warning).toBe("string");

    const [row, ...rest] = await storedRows();
    expect(rest).toEqual([]);
    expect(row).toEqual({
      url: SERVER_URL,
      serverName: "io-github-dev-weather",
      transport: { type: "streamable-http", auth: { type: "none" } },
      oauthScope: "workspace",
      ui: {
        placements: [
          {
            slot: "sidebar.apps",
            resourceUri: "ui://weather/main",
            label: "Weather",
            route: "weather",
          },
        ],
      },
      display: {
        title: "Weather (dev)",
        description: "Forecasts, in development",
        iconUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      },
    });
    const raw = JSON.stringify(row);
    for (const grant of ["hooks", "adminTools", "recordArguments", "notifications"]) {
      expect(raw).not.toContain(grant);
    }
    expect(h.lifecycle.getInstance("io-github-dev-weather", WS)?.ui?.placements).toHaveLength(1);
  });

  test("fetches the card at <url>/server-card, through the alias, with its media type", async () => {
    await install();
    expect(h.requests[0]).toEqual({
      url: `http://${ALIAS}:8000/mcp/server-card`,
      host: "127.0.0.1:8000",
      accept: SERVER_CARD_MEDIA_TYPE,
    });
  });

  test("the caller's serverName wins over the card's name", async () => {
    const result = await install(SERVER_URL, "My Weather");
    expect(sc(result).serverName).toBe("my-weather");
  });
});

describe("the server name", () => {
  test("refuses NAME_TAKEN when the workspace already has a connector by that name", async () => {
    expect((await install()).isError).toBe(false);
    const again = await install("http://localhost:9000/mcp");
    expect(again.isError).toBe(true);
    expect(sc(again).error).toBe("NAME_TAKEN");
    expect(await storedRows()).toHaveLength(1);
  });

  test("refuses NAME_IS_CATALOG_ENTRY when a catalog entry slugifies to it", async () => {
    const result = await install(SERVER_URL, "com.notion/mcp");
    expect(result.isError).toBe(true);
    expect(sc(result).error).toBe("NAME_IS_CATALOG_ENTRY");
    expect(await storedRows()).toEqual([]);
  });

  test("refuses a reserved name", async () => {
    const result = await install(SERVER_URL, "nb");
    expect(result.isError).toBe(true);
    expect(sc(result).error).toBe("INVALID_SERVER_NAME");
  });
});

describe("an install with no usable card", () => {
  test.each([
    ["a 404", { body: "not found", status: 404 }],
    ["a body that is not JSON", { body: "<html>", status: 200 }],
    ["a JSON array", { body: [], status: 200 }],
    [
      "a card streamed past the size cap",
      { body: { ...CARD, description: "x".repeat(SERVER_CARD_MAX_BYTES) }, status: 200 },
    ],
    [
      "a card whose declared length is past the size cap",
      {
        body: CARD,
        status: 200,
        headers: { "content-length": String(SERVER_CARD_MAX_BYTES + 1) },
      },
    ],
  ])("%s installs under the host-port name with no display or placements", async (_l, card) => {
    h.card = card;
    const result = await install("http://localhost:8123/mcp");
    expect(result.isError).toBe(false);
    expect(sc(result).serverName).toBe("localhost-8123");
    expect(sc(result).placements).toEqual([]);
    const [row] = await storedRows();
    expect(row?.ui).toBeUndefined();
    expect(row?.display).toBeUndefined();
  });
});

describe("parseServerCard", () => {
  test("takes only placements from the host block", () => {
    expect(parseServerCard(CARD)?.ui).toEqual({
      placements: [
        {
          slot: "sidebar.apps",
          resourceUri: "ui://weather/main",
          label: "Weather",
          route: "weather",
        },
      ],
    });
  });

  test("drops non-string and control-character display fields", () => {
    expect(parseServerCard({ name: 42, title: "\u0000\u0007", description: "ok\u0000" })).toEqual({
      description: "ok",
    });
  });

  test("serverCardUrl appends under the MCP path and drops the query", () => {
    expect(serverCardUrl(new URL("http://127.0.0.1:8000/mcp/?x=1")).toString()).toBe(
      "http://127.0.0.1:8000/mcp/server-card",
    );
  });

  test.each([
    ["https://cdn.example.com/i.png", true],
    ["data:image/png;base64,AAAA", true],
    ["http://localhost:8000/icon.svg", true],
    ["http://127.0.0.1/icon.svg", true],
    ["http://cdn.example.com/i.png", false],
    ["http://10.0.0.5/i.png", false],
    ["data:text/html,<script>", false],
    ["javascript:alert(1)", false],
    ["https://user:pw@cdn.example.com/i.png", false],
  ])("icon %p accepted: %p", (src, ok) => {
    expect(isAcceptedIconUrl(src)).toBe(ok);
  });
});
