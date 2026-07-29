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
import {
  _resetSmitheryConfigForTest,
  validateSmitheryConfig,
} from "../../src/connectors/providers/smithery/config.ts";

const ENV_KEYS = [
  "COMPOSIO_API_KEY",
  "COMPOSIO_API_BASE_URL",
  "COMPOSIO_MONITOR_ENABLED",
  "NB_TENANT_ID",
  "NB_OAUTH_BOUNCER_CALLBACK_URL",
  "NB_OAUTH_BOUNCER_TENANT_KEY",
  "SMITHERY_API_KEY",
  "SMITHERY_NAMESPACE",
  "SMITHERY_API_BASE_URL",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetConnectorsConfigForTest();
  _resetComposioConfigForTest();
  _resetBouncerModeForTest();
  _resetComposioVendorForTest();
  _resetSmitheryConfigForTest();
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
  _resetSmitheryConfigForTest();
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

    setConnectorsConfig({ providers: { composio: { monitorEnabled: false } } });
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

describe("buildManagedConnectorRegistry — Smithery config gating", () => {
  it("registers no smithery provider when unconfigured", () => {
    const registry = buildManagedConnectorRegistry();
    expect(registry.get("smithery")).toBeUndefined();
    expect(registry.has("smithery")).toBe(false);
  });

  it("stays unregistered when the API key is set but the namespace is not", () => {
    // A Smithery namespace is globally unique and account-owned — there is no
    // safe default, so a half-configured provider must not register.
    process.env.SMITHERY_API_KEY = "sk_test";
    _resetSmitheryConfigForTest();

    expect(buildManagedConnectorRegistry().get("smithery")).toBeUndefined();
  });

  it("takes the namespace from the declared block, no env needed", () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "declared-ns" } } });
    _resetSmitheryConfigForTest();

    expect(buildManagedConnectorRegistry().get("smithery")?.id).toBe("smithery");
  });

  it("declared namespace wins over the legacy env var", () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "env-ns" } } });
    setConnectorsConfig({ providers: { smithery: { namespace: "declared-ns" } } });
    _resetSmitheryConfigForTest();

    expect(validateSmitheryConfig().namespace).toBe("declared-ns");
  });

  it("resolves every setting from the one block", () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({
      providers: { smithery: { namespace: "ops-ns", monitorEnabled: false } },
    });
    _resetSmitheryConfigForTest();

    const config = validateSmitheryConfig();
    expect(config.namespace).toBe("ops-ns");
    expect(config.monitorEnabled).toBe(false);
  });

  it("leaves the provider unregistered when a blank namespace is declared", () => {
    // A Helm-templated nimblebrain.json renders `"namespace": "{{ .Values… }}"`
    // to "" when the value is unset. There is no env fallback to rescue it, so
    // the provider stays off rather than registering against a nameless account
    // — and the boot warning names the config key to set.
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "", baseUrl: "" } } });
    _resetSmitheryConfigForTest();

    expect(validateSmitheryConfig().namespace).toBe("");
    expect(buildManagedConnectorRegistry().get("smithery")).toBeUndefined();
  });

  it("omits the probe when the monitor is disabled, keeping session brokering", () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({
      providers: { smithery: { namespace: "declared-ns", monitorEnabled: false } },
    });
    _resetSmitheryConfigForTest();

    const provider = buildManagedConnectorRegistry().get("smithery");
    expect(provider).toBeDefined();
    expect(provider?.probe).toBeUndefined();
    expect(typeof provider?.createSession).toBe("function");
  });

  it("registers a smithery provider when fully configured", () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });
    _resetSmitheryConfigForTest();

    const provider = buildManagedConnectorRegistry().get("smithery");
    expect(provider?.id).toBe("smithery");
    expect(typeof provider?.createSession).toBe("function");
    expect(provider?.probe).toBeDefined();
    // Smithery brokers OAuth on its own hosted page, so it owns no callback surface.
    expect(provider?.routes).toBeUndefined();
  });

  it("registers both providers independently — neither gates the other", () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns" } } });
    _resetComposioConfigForTest();
    _resetSmitheryConfigForTest();

    const registry = buildManagedConnectorRegistry();
    expect(
      registry
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["composio", "smithery"]);

    // Registering Smithery must not drag the Composio vendor in.
    expect(_composioVendorLoadCountForTest()).toBe(0);
  });
});

describe("smithery baseUrl validation", () => {
  it("rejects a non-http(s) baseUrl — it becomes an installed connector's MCP target", () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns", baseUrl: "file:///etc/passwd" } } });
    _resetSmitheryConfigForTest();

    expect(() => validateSmitheryConfig()).toThrow(/must be http\(s\)/);
  });

  it("rejects an unparseable baseUrl", () => {
    process.env.SMITHERY_API_KEY = "sk_test";
    setConnectorsConfig({ providers: { smithery: { namespace: "test-ns", baseUrl: "not a url" } } });
    _resetSmitheryConfigForTest();

    expect(() => validateSmitheryConfig()).toThrow(/not a valid URL/);
  });
});

describe("Composio asserts authConfigId at its own boundary", () => {
  it("throws when the seam omits it — the field the seam made optional", async () => {
    process.env.COMPOSIO_API_KEY = "k_test";
    _resetComposioConfigForTest();

    const provider = buildManagedConnectorRegistry().get("composio");
    // `authConfigId` is optional at the seam because Smithery has no such
    // concept. Composio requires one, so it must reject the omission itself —
    // without this the vendor call would bind a toolkit to `undefined`.
    await expect(
      provider?.createSession({ userId: "ws_01abc", toolkit: "gmail" }),
    ).rejects.toThrow(/requires an authConfigId/);
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
