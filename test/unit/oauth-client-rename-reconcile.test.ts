import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getNimbleBrainConnectorMeta,
  NIMBLEBRAIN_CONNECTOR_META_KEY,
  type ServerDetail,
} from "../../src/connectors/catalog/server-detail.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

// The two reads that carry stored data and the shared catalog across the
// rename of the per-workspace OAuth client: `oauthOperatorApps` →
// `oauthClients` on disk, `operatorSetup` → `oauthClientSetup` in the catalog.

const WS = "ws_0a1b2c3d4e5f6a7b";
const RECORD = { clientId: "cid", configuredAt: "2026-01-01T00:00:00.000Z", configuredBy: "usr_a" };

describe("WorkspaceStore.reconcileOAuthClientRecords", () => {
  let workDir: string;
  let store: WorkspaceStore;

  const file = () => join(store.getWorkspacesDir(), WS, "workspace.json");
  const raw = () => JSON.parse(readFileSync(file(), "utf-8")) as Record<string, unknown>;
  const writeRaw = (patch: Record<string, unknown>) =>
    writeFileSync(file(), JSON.stringify({ ...raw(), ...patch }));

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-client-reconcile-"));
    store = new WorkspaceStore(workDir);
    await seedWorkspace(store, WS);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("copies the earlier key to oauthClients and leaves it on disk for a rollback", async () => {
    writeRaw({ oauthOperatorApps: { "com.example/mcp": RECORD } });
    expect(await store.reconcileOAuthClientRecords()).toEqual({ copied: 1, failed: 0 });
    expect(raw().oauthClients).toEqual({ "com.example/mcp": RECORD });
    expect(raw().oauthOperatorApps).toEqual({ "com.example/mcp": RECORD });
    expect((await store.get(WS))?.oauthClients).toEqual({ "com.example/mcp": RECORD });
  });

  test("copies once, so a client removed afterwards stays removed", async () => {
    writeRaw({ oauthOperatorApps: { "com.example/mcp": RECORD } });
    await store.reconcileOAuthClientRecords();
    await store.update(WS, { oauthClients: {} });
    expect(await store.reconcileOAuthClientRecords()).toEqual({ copied: 0, failed: 0 });
    expect((await store.get(WS))?.oauthClients).toEqual({});
  });

  test("leaves a workspace with neither key untouched", async () => {
    const before = readFileSync(file(), "utf-8");
    expect(await store.reconcileOAuthClientRecords()).toEqual({ copied: 0, failed: 0 });
    expect(readFileSync(file(), "utf-8")).toBe(before);
  });
});

describe("getNimbleBrainConnectorMeta across the setup rename", () => {
  const setup = { portalUrl: "https://portal.example", hint: "h", clientSecretKey: "k" };
  const detail = (meta: Record<string, unknown>): ServerDetail =>
    ({
      name: "com.example/mcp",
      description: "d",
      version: "1.0.0",
      _meta: { [NIMBLEBRAIN_CONNECTOR_META_KEY]: { auth: "static", ...meta } },
    }) as ServerDetail;

  test("reads the earlier operatorSetup name as oauthClientSetup", () => {
    const meta = getNimbleBrainConnectorMeta(detail({ operatorSetup: setup }));
    expect(meta?.oauthClientSetup).toEqual(setup);
    expect(meta && "operatorSetup" in meta).toBe(false);
  });

  test("the current name wins when an entry carries both", () => {
    const current = { ...setup, clientSecretKey: "current" };
    const meta = getNimbleBrainConnectorMeta(
      detail({ operatorSetup: setup, oauthClientSetup: current }),
    );
    expect(meta?.oauthClientSetup).toEqual(current);
  });
});
