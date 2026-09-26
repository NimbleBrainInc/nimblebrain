/**
 * A workspace addressed by URL: the one admission rule `/mcp/<wsId>` and
 * `/v1/workspaces/<wsId>/…` share. Mostly negative cases — each is a way a
 * request could reach, or learn about, a workspace it should not.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requireWorkspace } from "../../../src/api/middleware/workspace.ts";
import type { AppContext, AppEnv } from "../../../src/api/types.ts";
import {
  isAddressedWorkspaceMember,
  isWorkspaceIdShape,
} from "../../../src/api/workspace-address.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import type { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

const ALICE: UserIdentity = {
  id: "usr_alice",
  email: "alice@example.com",
  displayName: "Alice",
  orgRole: "member",
};

interface StoredWorkspace {
  id: string;
  members: Array<{ userId: string; role: string }>;
}

const WORKSPACES: Record<string, StoredWorkspace> = {
  ws_acme: { id: "ws_acme", members: [{ userId: ALICE.id, role: "member" }] },
  ws_other: { id: "ws_other", members: [{ userId: "usr_bob", role: "admin" }] },
  ws_dev: { id: "ws_dev", members: [{ userId: DEV_IDENTITY.id, role: "admin" }] },
};

/** A store that records every lookup, and resolves ids case-insensitively like a case-folding filesystem. */
function makeStore(): { store: WorkspaceStore; lookups: string[] } {
  const lookups: string[] = [];
  const store = {
    get: async (id: string) => {
      lookups.push(id);
      return WORKSPACES[id.toLowerCase()] ?? null;
    },
  } as unknown as WorkspaceStore;
  return { store, lookups };
}

describe("isAddressedWorkspaceMember", () => {
  it("admits a member of the addressed workspace", async () => {
    const { store } = makeStore();
    expect(await isAddressedWorkspaceMember(store, "ws_acme", ALICE.id)).toBe(true);
  });

  it("checks the shape before any lookup", async () => {
    const { store, lookups } = makeStore();
    for (const wsId of ["", "acme", "ws_", "ws_../etc", "ws_a-b", "ws_a/b", `ws_${"a".repeat(65)}`]) {
      expect(isWorkspaceIdShape(wsId)).toBe(false);
      expect(await isAddressedWorkspaceMember(store, wsId, ALICE.id)).toBe(false);
    }
    expect(lookups).toEqual([]);
  });

  it("refuses an unknown workspace", async () => {
    const { store } = makeStore();
    expect(await isAddressedWorkspaceMember(store, "ws_nosuch", ALICE.id)).toBe(false);
  });

  it("refuses a workspace the caller does not belong to", async () => {
    const { store } = makeStore();
    expect(await isAddressedWorkspaceMember(store, "ws_other", ALICE.id)).toBe(false);
  });

  it("requires exact id equality, not the store's own matching", async () => {
    const { store } = makeStore();
    // The store resolves `WS_ACME` to `ws_acme`; the addressed id is not that id.
    expect(await isAddressedWorkspaceMember(store, "WS_ACME", ALICE.id)).toBe(false);
  });
});

/** An app with one workspace-scoped route that echoes the workspace it was admitted to. */
function makeApp(opts: { identity?: UserIdentity; providerConfigured?: boolean } = {}) {
  const { store } = makeStore();
  const ctx = {
    workspaceStore: store,
    runtime: { getIdentityProvider: () => (opts.providerConfigured === false ? null : {}) },
  } as unknown as AppContext;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (opts.identity) c.set("identity", opts.identity);
    await next();
  });
  app.get("/v1/workspaces/:wsId/probe", requireWorkspace(ctx), (c) =>
    c.json({ workspaceId: c.var.workspaceId }),
  );
  return app;
}

async function probe(
  app: Hono<AppEnv>,
  wsId: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const res = await app.request(`http://nb.example.com/v1/workspaces/${wsId}/probe`, { headers });
  return { status: res.status, body: await res.text() };
}

describe("requireWorkspace", () => {
  it("admits a member and binds the workspace in the path", async () => {
    const res = await probe(makeApp({ identity: ALICE }), "ws_acme");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ workspaceId: "ws_acme" });
  });

  it("answers a malformed, an unknown and a non-member workspace identically", async () => {
    const app = makeApp({ identity: ALICE });
    const malformed = await probe(app, "ws_a-b");
    const unknown = await probe(app, "ws_nosuch");
    const nonMember = await probe(app, "ws_other");
    expect(malformed.status).toBe(404);
    expect(unknown).toEqual(malformed);
    expect(nonMember).toEqual(malformed);
    expect(JSON.parse(malformed.body).error).toBe("workspace_error");
  });

  it("ignores X-Workspace-Id: the path's workspace wins", async () => {
    const res = await probe(makeApp({ identity: ALICE }), "ws_acme", {
      "X-Workspace-Id": "ws_other",
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ workspaceId: "ws_acme" });
  });

  it("does not let a header naming the caller's own workspace admit another", async () => {
    const app = makeApp({ identity: ALICE });
    const refused = await probe(app, "ws_other");
    const withHeader = await probe(app, "ws_other", { "X-Workspace-Id": "ws_acme" });
    expect(withHeader).toEqual(refused);
  });

  it("admits no one when a provider is configured and the request has no identity", async () => {
    const app = makeApp({ providerConfigured: true });
    const refused = await probe(makeApp({ identity: ALICE }), "ws_nosuch");
    expect(await probe(app, "ws_dev")).toEqual(refused);
    expect(await probe(app, "ws_acme")).toEqual(refused);
  });

  it("treats an identity-less request as the dev user when no provider is configured", async () => {
    const app = makeApp({ providerConfigured: false });
    expect((await probe(app, "ws_dev")).status).toBe(200);
    expect((await probe(app, "ws_acme")).status).toBe(404);
  });
});
