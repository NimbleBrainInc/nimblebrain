/**
 * The secrets door, assembled by `Runtime.start` — the pieces a unit test
 * cannot see because they are properties of the composition root, not of any
 * one module.
 *
 * Three things are pinned here:
 *
 *   1. `Runtime.start` opens exactly one store and hands the same instance to
 *      both the accessor and the module handle the leaf readers use. Two stores
 *      would still work; they would just audit through different sinks and stop
 *      being one swap point, which is the failure this arrangement exists to
 *      prevent and which nothing else would catch.
 *   2. The `credential` transport credential is registered by `start` itself,
 *      before `startWorkspaceBundles` — a connector installed with it boots, and
 *      an unregistered name would drop its source on every restart. (The same
 *      defect the Composio boot test pins, for the same reason.)
 *   3. An instance-scope `{ ref: "credential" }` in the config `start` was
 *      handed is resolved before any reader sees it — asserted through the ONE
 *      value observable from outside, a declared gateway key, since the provider
 *      SDKs do not expose theirs.
 *
 * `bun test` shares one process and the credential-provider registry is a
 * process-global Map, so the registry is cleared before the boot: otherwise a
 * sibling file's registration would satisfy the assertion and pin nothing.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConnectorsConfigForTest } from "../../src/connectors/providers/config.ts";
import { gatewayCredentialProvider } from "../../src/connectors/gateways/transport-credential.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import {
  _resetCredentialProvidersForTest,
  getCredentialProvider,
} from "../../src/tools/credential-provider.ts";
import { requireCredentialStore } from "../../src/tools/credential-store.ts";
import { CREDENTIAL_PROVIDER } from "../../src/tools/credential-transport-credential.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

let runtime: Runtime;
let testDir: string;

beforeAll(async () => {
  testDir = mkdtempSync(join(tmpdir(), "secrets-door-boot-"));

  // Seed an instance-scope secret the way an operator would: one file, mode
  // 0600, under `credentials/secrets/`. No API writes instance scope.
  const secretsDir = join(testDir, "credentials", "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(secretsDir, "acme.gateway_key"), "gw-from-store\n", { mode: 0o600 });

  _resetConnectorsConfigForTest();
  _resetCredentialProvidersForTest();

  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    connectors: {
      gateways: { acme: { apiKey: { ref: "credential", key: "acme.gateway_key" } } },
    },
  });
});

afterAll(async () => {
  await runtime?.stop?.();
  rmSync(testDir, { recursive: true, force: true });
  _resetConnectorsConfigForTest();
  _resetCredentialProvidersForTest();
});

test("the runtime accessor and the module handle are the same store", () => {
  expect(runtime.getCredentialStore()).toBe(requireCredentialStore());
});

test("Runtime.start registers the `credential` transport credential", () => {
  expect(getCredentialProvider(CREDENTIAL_PROVIDER)).toBeDefined();
});

test("registering it does not displace the other built-ins", () => {
  for (const name of ["minted", "composio", "smithery"]) {
    expect(getCredentialProvider(name)).toBeDefined();
  }
});

test("an instance-scope reference is resolved before any config reader sees it", () => {
  // The gateway resolves its key from the installed `connectors` block on every
  // `credentialFor`, so this reads exactly what `setConnectorsConfig` was given
  // — which is the config AFTER dereferencing, or this is the raw ref object and
  // the header would read `Bearer [object Object]`.
  expect(gatewayCredentialProvider("acme").credentialFor(undefined, {})).toEqual({
    headers: { Authorization: "Bearer gw-from-store" },
  });
});

test("the store the runtime hands out reads that same instance scope", async () => {
  const wrapped = await runtime
    .getCredentialStore()
    .get({ kind: "instance" }, "acme.gateway_key", { caller: "test", purpose: "boot assertion" });
  // The trailing newline an `echo > file` leaves is trimmed on read.
  expect(wrapped?.reveal()).toBe("gw-from-store");
});
