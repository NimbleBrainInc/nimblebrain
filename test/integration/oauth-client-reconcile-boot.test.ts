/**
 * `Runtime.start` moves stored OAuth client records to `oauthClients` before
 * anything reads a workspace. The store method has its own unit tests; this
 * pins that the boot runs it, since every existing static-auth workspace
 * depends on that call and no other test would notice it missing.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../../src/runtime/runtime.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { seedWorkspace } from "../helpers/test-workspace.ts";

const WS = "ws_0a1b2c3d4e5f6a7b";
const RECORD = { clientId: "cid", configuredAt: "2026-01-01T00:00:00.000Z", configuredBy: "usr_a" };

let workDir: string;
let runtime: Runtime | undefined;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "nb-oauth-client-boot-"));
  const store = new WorkspaceStore(workDir);
  await seedWorkspace(store, WS);
  const file = join(store.getWorkspacesDir(), WS, "workspace.json");
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, oauthOperatorApps: { "com.example/mcp": RECORD } }));
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

test("Runtime.start copies stored records to oauthClients before readers see the workspace", async () => {
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir,
  });
  const ws = await runtime.getWorkspaceStore().get(WS);
  expect(ws?.oauthClients).toEqual({ "com.example/mcp": RECORD });
});
