import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { connectionsRoutes } from "../../../src/api/routes/connections.ts";
import type { AppContext, AppEnv } from "../../../src/api/types.ts";
import { loadCatalog } from "../../../src/connections/load-catalog.ts";

/**
 * Coverage for `POST /v1/connections/install`. The route mutates
 * workspace.json + seeds the runtime lifecycle, so we wire fakes for
 * both. The catalog is the real loader (default catalog) — keeping it
 * real catches drift if entry shapes change.
 */

const WS_ID = "ws_test";

interface FakeBundles {
  url: string;
  serverName?: string;
  oauthScope?: "workspace" | "member";
}

function makeApp(opts: {
  initialBundles?: FakeBundles[];
  allowList?: string[];
  workspaceMissing?: boolean;
}): {
  app: Hono<AppEnv>;
  state: { bundles: FakeBundles[]; seeded: Array<{ serverName: string; wsId: string }> };
} {
  const state = {
    bundles: [...(opts.initialBundles ?? [])],
    seeded: [] as Array<{ serverName: string; wsId: string }>,
  };

  const ctx = {
    authOptions: { mode: { type: "dev" }, eventSink: { emit: () => {} } },
    isLocalhost: true,
    workspaceStore: {
      get: async (id: string) => {
        if (opts.workspaceMissing) return null;
        return {
          id,
          name: "Test",
          members: [],
          bundles: state.bundles,
          ...(opts.allowList ? { connectionsAllowList: opts.allowList } : {}),
          createdAt: "",
          updatedAt: "",
        };
      },
      update: async (_id: string, patch: { bundles: FakeBundles[] }) => {
        state.bundles = patch.bundles;
        return {
          id: _id,
          name: "Test",
          members: [],
          bundles: state.bundles,
          createdAt: "",
          updatedAt: "now",
        };
      },
    },
    runtime: {
      getLifecycle: () => ({
        seedInstance: (sn: string, _bn: string, _ref: unknown, _meta: unknown, wsId: string) => {
          state.seeded.push({ serverName: sn, wsId });
        },
      }),
      getRegistryForWorkspace: () => undefined,
      getWorkDir: () => "/tmp/nb-test",
      getAllowInsecureRemotes: () => false,
    },
  } as unknown as AppContext;

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("workspaceId", WS_ID);
    await next();
  });
  app.route("/", connectionsRoutes(ctx));
  return { app, state };
}

describe("POST /v1/connections/install", () => {
  // Use a real catalog entry. Granola is DCR/member-scope and the
  // simplest happy-path target.
  let granolaId: string;

  beforeEach(() => {
    const catalog = loadCatalog();
    const granola = catalog.find((e) => e.id === "granola");
    if (!granola) throw new Error("default catalog must include 'granola'");
    granolaId = granola.id;
  });

  test("400 on non-JSON body", async () => {
    const { app } = makeApp({});
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
  });

  test("400 when catalogId is missing", async () => {
    const { app } = makeApp({});
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("404 when workspace doesn't exist", async () => {
    const { app } = makeApp({ workspaceMissing: true });
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: granolaId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("workspace_not_found");
  });

  test("404 when catalogId not in catalog", async () => {
    const { app } = makeApp({});
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "no-such-id" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("catalog_entry_not_found");
  });

  test("404 when catalogId not in workspace allow-list", async () => {
    const { app } = makeApp({ allowList: ["notion-org"] });
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: granolaId }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("catalog_entry_not_found");
  });

  test("409 when catalog entry is auth=static (operator setup required)", async () => {
    // gmail / hubspot / asana / outlook / zoom are static-auth in the
    // default catalog. Pick one to verify the rejection path.
    const catalog = loadCatalog();
    const staticEntry = catalog.find((e) => e.auth === "static");
    if (!staticEntry) throw new Error("default catalog must include a static-auth entry");

    const { app, state } = makeApp({});
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: staticEntry.id }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("operator_setup_required");
    // No bundle was added.
    expect(state.bundles).toHaveLength(0);
    expect(state.seeded).toHaveLength(0);
  });

  test("happy path: adds bundle to workspace.json + seeds lifecycle", async () => {
    const { app, state } = makeApp({});
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: granolaId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alreadyInstalled).toBe(false);
    expect(body.serverName).toBe(granolaId);
    expect(state.bundles).toHaveLength(1);
    expect(state.bundles[0]).toMatchObject({
      url: expect.stringContaining("granola"),
      serverName: granolaId,
      oauthScope: "member",
    });
    expect(state.seeded).toEqual([{ serverName: granolaId, wsId: WS_ID }]);
  });

  test("idempotent: alreadyInstalled=true if URL already in workspace.bundles[]", async () => {
    const catalog = loadCatalog();
    const granola = catalog.find((e) => e.id === "granola")!;
    const { app, state } = makeApp({
      initialBundles: [{ url: granola.url, serverName: "granola-existing" }],
    });
    const res = await app.request("http://localhost/v1/connections/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: granolaId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyInstalled).toBe(true);
    expect(body.serverName).toBe("granola-existing");
    // Bundles unchanged, lifecycle NOT re-seeded.
    expect(state.bundles).toHaveLength(1);
    expect(state.seeded).toHaveLength(0);
  });
});
