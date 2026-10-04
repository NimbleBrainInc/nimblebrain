/**
 * The set of platform apps a workspace boots with.
 *
 * A platform app is booted into every workspace registry and every tool it
 * lists is visible to the agent, so an app without a caller still costs each
 * turn its tool definitions. Raw workspace activity telemetry has no caller,
 * so no `home` source serves it.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { ensureUserWorkspace } from "../../src/workspace/provisioning.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

let runtime: Runtime;
let testDir: string;
let sourceNames: string[];
let toolNames: string[];

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "platform-sources-"));
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: testDir,
  });
  const [ws] = await ensureUserWorkspace(runtime.getWorkspaceStore(), {
    id: DEV_IDENTITY.id,
    displayName: DEV_IDENTITY.displayName,
  });
  const wsId = ws!.id;
  // Listing tools provisions the workspace registry, so it comes first.
  toolNames = (await runtime.listToolsForWorkspace(wsId, DEV_IDENTITY.id)).map((t) => t.name);
  sourceNames = runtime.getRegistryForWorkspace(wsId).sourceNames();
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(testDir, { recursive: true, force: true });
});

test("no `home` source registers", () => {
  // The positive control: the registry read is the one that holds platform apps.
  expect(sourceNames).toContain("usage");
  expect(sourceNames).not.toContain("home");
  expect(toolNames.filter((name) => name.startsWith("home__"))).toEqual([]);
});
