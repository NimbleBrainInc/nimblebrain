/**
 * The managed-connector provider registry + the lazy-vendor invariant.
 *
 * This pins the flake fix made explicit: with Composio UNCONFIGURED the registry
 * holds no provider AND `@composio/core` is never imported. The recurring
 * "Export named 'AuthScheme' not found" unit-test flake came from the vendor
 * being statically linked at boot before a test's `mock.module` could apply;
 * with the vendor behind a config-gated, lazily-loaded provider, an unconfigured
 * process links nothing.
 *
 * Note this suite mocks nothing — it deliberately never triggers a vendor load,
 * so the load-counter assertions read the real state of the (unmocked) seam.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { _resetComposioConfigForTest } from "../../src/connectors/providers/composio/config.ts";
import {
  _composioVendorLoadCountForTest,
  _resetComposioVendorForTest,
} from "../../src/connectors/providers/composio/sdk.ts";
import type { ManagedConnectorProvider } from "../../src/connectors/providers/managed-provider.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import {
  buildManagedConnectorRegistry,
  managedConnectorRegistryOf,
} from "../../src/connectors/providers/registry.ts";
import { _resetBouncerModeForTest } from "../../src/oauth/bouncer-config.ts";

const ENV_KEYS = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_API_BASE_URL",
  "COMPOSIO_MONITOR_ENABLED",
  "NB_TENANT_ID",
  "NB_OAUTH_BOUNCER_CALLBACK_URL",
  "NB_OAUTH_BOUNCER_TENANT_KEY",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
  _resetBouncerModeForTest();
  _resetComposioVendorForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
  _resetBouncerModeForTest();
  _resetComposioVendorForTest();
});

describe("buildManagedConnectorRegistry — Composio unconfigured", () => {
  it("registers no provider and never imports the vendor (the flake fix)", () => {
    // Neither a declared block nor COMPOSIO_API_KEY (both cleared by beforeEach).
    const registry = buildManagedConnectorRegistry();

    expect(registry.get("composio")).toBeUndefined();
    expect(registry.has("composio")).toBe(false);
    expect(registry.list()).toEqual([]);

    // The whole point: no provider ⇒ no brokered call ⇒ the vendor SDK was
    // never dynamically imported.
    expect(_composioVendorLoadCountForTest()).toBe(0);
  });
});

describe("buildManagedConnectorRegistry — settings declared in nimblebrain.json", () => {
  beforeEach(() => {
    // The credential is what gates registration. Declared or from the env — this
    // suite drives the env arm; `composio-config.test.ts` owns the precedence.
    process.env.COMPOSIO_API_KEY = "k_env";
  });

  it("registers the provider with settings taken from the block", () => {
    setConnectorsConfig({ providers: { composio: { baseUrl: "https://composio.internal" } } });
    _resetComposioConfigForTest();

    const registry = buildManagedConnectorRegistry();
    expect(registry.has("composio")).toBe(true);
    expect(registry.get("composio")?.probe).toBeDefined();
    // Registration is a pure config read — still no vendor link.
    expect(_composioVendorLoadCountForTest()).toBe(0);
  });

  it("wires the probe when the block enables it", () => {
    setConnectorsConfig({ providers: { composio: { monitorEnabled: true } } });
    _resetComposioConfigForTest();

    expect(buildManagedConnectorRegistry().get("composio")?.probe).toBeDefined();
  });

  it("omits the probe under the block's kill switch", () => {
    setConnectorsConfig({ providers: { composio: { monitorEnabled: false } } });
    _resetComposioConfigForTest();

    expect(buildManagedConnectorRegistry().get("composio")?.probe).toBeUndefined();
  });

  it("registers nothing when the credential is absent, however complete the block", () => {
    delete process.env.COMPOSIO_API_KEY;
    setConnectorsConfig({
      providers: { composio: { baseUrl: "https://composio.internal", monitorEnabled: true } },
    });
    _resetComposioConfigForTest();

    expect(buildManagedConnectorRegistry().has("composio")).toBe(false);
    expect(_composioVendorLoadCountForTest()).toBe(0);
  });
});

describe("buildManagedConnectorRegistry — Composio configured", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "k_test";
    _resetComposioConfigForTest();
    _resetComposioVendorForTest();
  });

  it("registers a composio provider with the brokered surface", () => {
    const registry = buildManagedConnectorRegistry();
    const provider = registry.get("composio");

    expect(provider).toBeDefined();
    expect(registry.has("composio")).toBe(true);
    expect(registry.list().map((p) => p.id)).toEqual(["composio"]);
    expect(provider?.id).toBe("composio");

    // The full brokered surface is present (Composio implements both auth arms).
    expect(typeof provider?.userId).toBe("function");
    expect(typeof provider?.createSession).toBe("function");
    expect(typeof provider?.initiate).toBe("function");
    expect(typeof provider?.connectApiKey).toBe("function");
    expect(typeof provider?.findActive).toBe("function");
    expect(typeof provider?.delete).toBe("function");
    expect(typeof provider?.routes).toBe("function");
  });

  it("wires a probe by default and omits it under the monitor kill switch", () => {
    expect(buildManagedConnectorRegistry().get("composio")?.probe).toBeDefined();

    process.env.COMPOSIO_MONITOR_ENABLED = "false";
    _resetComposioConfigForTest();
    expect(buildManagedConnectorRegistry().get("composio")?.probe).toBeUndefined();
  });

  it("derives the owner userId without loading the vendor (userId is vendor-free)", () => {
    const provider = buildManagedConnectorRegistry().get("composio");
    expect(provider?.userId({ type: "workspace", wsId: "ws_01abc" })).toBe("ws_01abc");
    // Constructing the provider and calling the vendor-free `userId` links nothing.
    expect(_composioVendorLoadCountForTest()).toBe(0);
  });
});

describe("managedConnectorRegistryOf — the target test model (register a fake provider)", () => {
  it("holds an injected fake provider without touching any vendor", () => {
    const fake: ManagedConnectorProvider = {
      id: "composio",
      userId: () => "u",
      createSession: async () => ({ type: "http", url: "https://fake/mcp" }),
    };
    const registry = managedConnectorRegistryOf([fake]);
    expect(registry.get("composio")).toBe(fake);
    expect(registry.list()).toEqual([fake]);
    expect(_composioVendorLoadCountForTest()).toBe(0);
  });
});

describe("the vendor SDK is lazy by construction", () => {
  it("sdk.ts imports @composio/core only dynamically (no top-level import)", () => {
    const sdkSource = readFileSync(
      join(import.meta.dir, "../../src/connectors/providers/composio/sdk.ts"),
      "utf-8",
    );
    // A top-level `import ... from "@composio/core"` is exactly what re-links the
    // vendor at boot and reintroduces the flake. The only allowed reference is
    // the dynamic `import("@composio/core")` inside the lazy loader.
    expect(sdkSource).not.toMatch(/from\s+["']@composio\/core["']/);
    expect(sdkSource).toContain('import("@composio/core")');
  });
});
