import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

// Stored OAuth client records move off `oauthOperatorApps`, the key they had
// before, onto `oauthClients`; the old key is deleted.

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
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-client-records-"));
    store = new WorkspaceStore(workDir);
    await seedWorkspace(store, WS);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("deletes the old key once the records are on oauthClients", async () => {
    writeRaw({
      oauthOperatorApps: { "com.example/mcp": RECORD },
      oauthClients: { "com.example/mcp": RECORD },
    });
    expect(await store.reconcileOAuthClientRecords()).toEqual({ moved: 1, failed: 0 });
    expect(raw().oauthClients).toEqual({ "com.example/mcp": RECORD });
    expect("oauthOperatorApps" in raw()).toBe(false);
  });

  test("keeps the current records over the old key", async () => {
    const current = { ...RECORD, clientId: "current" };
    writeRaw({
      oauthOperatorApps: { "com.example/mcp": RECORD },
      oauthClients: { "com.example/mcp": current },
    });
    await store.reconcileOAuthClientRecords();
    expect(raw().oauthClients).toEqual({ "com.example/mcp": current });
  });

  test("keeps a removal made after the copy", async () => {
    writeRaw({ oauthOperatorApps: { "com.example/mcp": RECORD }, oauthClients: {} });
    await store.reconcileOAuthClientRecords();
    expect(raw().oauthClients).toEqual({});
  });

  test("copies first for a workspace that never had the copy", async () => {
    writeRaw({ oauthOperatorApps: { "com.example/mcp": RECORD } });
    expect(await store.reconcileOAuthClientRecords()).toEqual({ moved: 1, failed: 0 });
    expect(raw().oauthClients).toEqual({ "com.example/mcp": RECORD });
    expect("oauthOperatorApps" in raw()).toBe(false);
  });

  test("leaves a workspace without the old key untouched", async () => {
    const before = readFileSync(file(), "utf-8");
    expect(await store.reconcileOAuthClientRecords()).toEqual({ moved: 0, failed: 0 });
    expect(readFileSync(file(), "utf-8")).toBe(before);
  });
});
