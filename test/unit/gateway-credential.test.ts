import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  gatewayApiKeyEnvVar,
  gatewayCredentialProvider,
  registerGatewayCredentialProviders,
} from "../../src/connectors/gateways/transport-credential.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import { MINTED_PROVIDER } from "../../src/oauth/minted-credential-provider.ts";
import { COMPOSIO_CREDENTIAL_PROVIDER } from "../../src/connectors/providers/composio/transport-credential.ts";
import { SMITHERY_CREDENTIAL_PROVIDER } from "../../src/connectors/providers/smithery/transport-credential.ts";
import {
  _resetCredentialProvidersForTest,
  getCredentialProvider,
  registerCredentialProvider,
} from "../../src/tools/credential-provider.ts";

const ENV_KEYS = ["MCP360_API_KEY", "GLAMA_API_KEY", "MY_GATEWAY_API_KEY"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetConnectorsConfigForTest();
  _resetCredentialProvidersForTest();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetConnectorsConfigForTest();
  _resetCredentialProvidersForTest();
});

describe("reserved names cover every built-in credential provider", () => {
  // Gateways register LAST at the composition root, so last-writer-wins means a
  // declared gateway named after a built-in would replace it. The reserved-name
  // list is the only thing stopping that — ordering is what creates the exposure,
  // not what closes it. So the list has to track the built-ins, and this pins it:
  // register a new built-in without reserving its name and this fails here rather
  // than silently shipping a config that can hijack it.
  test.each([
    ["minted", MINTED_PROVIDER],
    ["composio", COMPOSIO_CREDENTIAL_PROVIDER],
    ["smithery", SMITHERY_CREDENTIAL_PROVIDER],
  ])("a gateway may not claim %s", (_label, builtinName) => {
    const sentinel = { credentialFor: () => ({ headers: { Authorization: "Bearer builtin" } }) };
    registerCredentialProvider(builtinName, sentinel);
    setConnectorsConfig({ gateways: { [builtinName]: { apiKey: "sk-gateway" } } });
    registerGatewayCredentialProviders();

    expect(getCredentialProvider(builtinName)?.credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer builtin" },
    });
  });
});

describe("gatewayApiKeyEnvVar", () => {
  test("upper-cases the name and appends _API_KEY", () => {
    expect(gatewayApiKeyEnvVar("mcp360")).toBe("MCP360_API_KEY");
    expect(gatewayApiKeyEnvVar("glama")).toBe("GLAMA_API_KEY");
  });

  test("collapses non-alphanumeric runs to a single underscore", () => {
    expect(gatewayApiKeyEnvVar("my-gateway")).toBe("MY_GATEWAY_API_KEY");
    expect(gatewayApiKeyEnvVar("my..gateway")).toBe("MY_GATEWAY_API_KEY");
  });
});

describe("gatewayCredentialProvider", () => {
  test("attaches the declared key as a bearer token", () => {
    setConnectorsConfig({ gateways: { mcp360: { apiKey: "sk-declared" } } });
    expect(gatewayCredentialProvider("mcp360").credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer sk-declared" },
    });
  });

  test("falls back to <NAME>_API_KEY when nothing is declared", () => {
    process.env.MCP360_API_KEY = "sk-from-env";
    setConnectorsConfig({ gateways: { mcp360: {} } });
    expect(gatewayCredentialProvider("mcp360").credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer sk-from-env" },
    });
  });

  test("treats a blank declared key as absent so a templated deploy still reads env", () => {
    process.env.MCP360_API_KEY = "sk-from-env";
    setConnectorsConfig({ gateways: { mcp360: { apiKey: "   " } } });
    expect(gatewayCredentialProvider("mcp360").credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer sk-from-env" },
    });
  });

  test("throws rather than attaching an empty bearer when no key resolves", () => {
    setConnectorsConfig({ gateways: { mcp360: {} } });
    expect(() => gatewayCredentialProvider("mcp360").credentialFor(undefined, {})).toThrow(
      /no API key configured/,
    );
  });

  test("names both config paths in the error so the operator can act on it", () => {
    setConnectorsConfig({ gateways: { mcp360: {} } });
    expect(() => gatewayCredentialProvider("mcp360").credentialFor(undefined, {})).toThrow(
      /connectors\.gateways\.mcp360\.apiKey.*MCP360_API_KEY/s,
    );
  });

  test("resolves per call, so one gateway's missing key never surfaces another's", () => {
    process.env.GLAMA_API_KEY = "sk-glama";
    setConnectorsConfig({ gateways: { mcp360: {}, glama: {} } });
    expect(gatewayCredentialProvider("glama").credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer sk-glama" },
    });
    expect(() => gatewayCredentialProvider("mcp360").credentialFor(undefined, {})).toThrow();
  });
});

describe("registerGatewayCredentialProviders", () => {
  test("registers one provider per declared gateway, under its own name", () => {
    setConnectorsConfig({
      gateways: { mcp360: { apiKey: "sk-a" }, glama: { apiKey: "sk-b" } },
    });
    registerGatewayCredentialProviders();

    expect(getCredentialProvider("mcp360")?.credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer sk-a" },
    });
    expect(getCredentialProvider("glama")?.credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer sk-b" },
    });
  });

  test("registers nothing when no gateways are declared", () => {
    setConnectorsConfig({ providers: { composio: { apiKey: "k" } } });
    registerGatewayCredentialProviders();
    expect(getCredentialProvider("mcp360")).toBeUndefined();
  });

  test("refuses a reserved name so a gateway cannot displace a broker's credential", () => {
    // Stand in for the real registration, which runs earlier at the composition root.
    registerCredentialProvider("smithery", {
      credentialFor: () => ({ headers: { Authorization: "Bearer broker-key" } }),
    });
    setConnectorsConfig({ gateways: { smithery: { apiKey: "sk-gateway" } } });
    registerGatewayCredentialProviders();

    expect(getCredentialProvider("smithery")?.credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer broker-key" },
    });
  });

  test("a reserved name does not stop the gateways declared beside it", () => {
    setConnectorsConfig({
      gateways: { composio: { apiKey: "sk-bad" }, mcp360: { apiKey: "sk-good" } },
    });
    registerGatewayCredentialProviders();

    expect(getCredentialProvider("mcp360")?.credentialFor(undefined, {})).toEqual({
      headers: { Authorization: "Bearer sk-good" },
    });
  });
});
