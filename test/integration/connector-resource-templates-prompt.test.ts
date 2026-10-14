/**
 * A connector's resource templates reach its entry in the prompt's apps list
 * (ADR-0049): `Runtime.buildAppsList` reads them off the live source, drops the
 * ones in a host-resolved scheme, and keeps the rest in the server's order.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { defineInProcessApp } from "../../src/tools/in-process-app.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const SERVER = "acme-crm";
const dir = join(tmpdir(), `nb-resource-templates-${Date.now()}`);
let runtime: Runtime;
let source: McpSource;

beforeAll(async () => {
  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    logging: { disabled: true },
    workDir: dir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);

  source = defineInProcessApp(
    {
      name: SERVER,
      version: "1.0.0",
      tools: [],
      resources: new Map([["crm://contacts/c1", "{}"]]),
      templates: [
        { uriTemplate: "crm://contacts/{id}", name: "contact" },
        { uriTemplate: "skill://acme-crm/{name}", name: "skill" },
        { uriTemplate: "crm://deals/{id}", name: "deal" },
      ],
    },
    new NoopEventSink(),
  );
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
  await runtime
    .getLifecycle()
    .seedInstance(
      SERVER,
      SERVER,
      { url: "https://crm.example.test/mcp", serverName: SERVER },
      undefined,
      TEST_WORKSPACE_ID,
    );
});

afterAll(async () => {
  await source?.stop();
  await runtime?.shutdown();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("connector resource templates in the apps list", () => {
  it("lists the connector's record templates, not its host-scheme ones", async () => {
    const apps = await runtime.buildAppsList(TEST_WORKSPACE_ID);
    const crm = apps.find((a) => a.name === SERVER);
    expect(crm?.resourceTemplates).toEqual([
      { uriTemplate: "crm://contacts/{id}", name: "contact" },
      { uriTemplate: "crm://deals/{id}", name: "deal" },
    ]);
  });
});
