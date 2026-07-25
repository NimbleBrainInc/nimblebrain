/**
 * The Composio transport credential must be registered by `Runtime.start`
 * itself, before `startWorkspaceBundles` runs.
 *
 * This pins the defect that shipped in this PR's first cut: registration lived
 * in `createComposioProvider`, which runs only when the managed-connector
 * registry is first built — lazily, after `start()` has returned. A connected
 * Composio connector starts *inside* `start()`, so `applyProviderAuth` threw
 * `provider "composio" is not registered`, `startup.ts` dropped the source, and
 * every Composio connector lost its tools on every restart.
 *
 * It lives in `test/integration/` because it calls `Runtime.start()`, and it
 * asserts against a **cleared** registry: the registry is a process-global Map
 * and `bun test` shares one process, so a unit-level assertion would be
 * satisfied by any sibling file's registration and would pin nothing. Deleting
 * `registerComposioCredentialProvider()` from `Runtime.start` must fail this
 * test — that is the only property it exists to hold.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import { _resetConnectorsConfigForTest } from "../../src/connectors/providers/config.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import {
  _resetCredentialProvidersForTest,
  getCredentialProvider,
} from "../../src/tools/credential-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

let runtime: Runtime;
let testDir: string;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "composio-credential-boot-"));
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
  // Clear whatever sibling suites registered, so what we observe below can only
  // have come from this `Runtime.start` call.
  _resetCredentialProvidersForTest();

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
  });
});

afterAll(async () => {
  await runtime?.stop?.();
  rmSync(testDir, { recursive: true, force: true });
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
});

test("Runtime.start registers the composio transport credential", () => {
  expect(getCredentialProvider("composio")).toBeDefined();
});

test("it registers regardless of whether Composio is configured", () => {
  // Registration is deliberately unconditional: a ref naming the provider on a
  // Composio-less deploy should fail with `credentialFor`'s "no broker
  // credential configured", which names the cause — not the registry's generic
  // "provider not registered". This boot had no COMPOSIO_API_KEY and no declared
  // block, and the provider is still present.
  expect(process.env.COMPOSIO_API_KEY ?? "").toBe("");
  expect(getCredentialProvider("composio")).toBeDefined();
});

test("the minted fleet provider is still registered alongside it", () => {
  // The composition root registers both; adding one must not displace the other.
  expect(getCredentialProvider("minted")).toBeDefined();
});
