import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorCatalog } from "../../src/connectors/catalog/catalog.ts";
import {
  _resetConnectorsConfigForTest,
  type OperatorAppConfigs,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import { resolveStaticOAuthClient } from "../../src/connectors/runtime/oauth-static-client.ts";
import {
  _resetInstanceOperatorAppsForTest,
  bindInstanceOperatorApps,
  instanceOperatorApp,
  operatorAppSecretEnvVar,
} from "../../src/connectors/runtime/operator-apps.ts";
import type { ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";
import { installTestCredentialStore } from "../helpers/credential-store.ts";

// `auth: static` in the connector fixture; `com.notion/mcp` there is DCR.
const DROPBOX_ID = "com.dropbox/mcp";
const DROPBOX_URL = "https://mcp.dropbox.com/mcp";
const DROPBOX_ENV = "COM_DROPBOX_MCP_CLIENT_SECRET";

async function bind(apps: OperatorAppConfigs): Promise<void> {
  setConnectorsConfig({ operatorApps: apps });
  await bindInstanceOperatorApps(() =>
    new ConnectorCatalog(CONNECTOR_FIXTURE_DIR).catalogByIdMap(),
  );
}

afterEach(() => {
  _resetConnectorsConfigForTest();
  _resetInstanceOperatorAppsForTest();
  delete process.env[DROPBOX_ENV];
});

describe("bindInstanceOperatorApps", () => {
  test("names the env fallback after the catalog id", () => {
    expect(operatorAppSecretEnvVar(DROPBOX_ID)).toBe(DROPBOX_ENV);
  });

  test("binds a declared app to the URL the catalog publishes for its id", async () => {
    await bind({ [DROPBOX_ID]: { clientId: "cid", clientSecret: "sec" } });
    expect(instanceOperatorApp(DROPBOX_ID)).toEqual({
      catalogId: DROPBOX_ID,
      clientId: "cid",
      clientSecret: "sec",
      url: DROPBOX_URL,
    });
  });

  test("reads the secret from its env var when none is declared", async () => {
    process.env[DROPBOX_ENV] = "from-env";
    await bind({ [DROPBOX_ID]: { clientId: "cid" } });
    expect(instanceOperatorApp(DROPBOX_ID)?.clientSecret).toBe("from-env");
  });

  test("a blank declared secret falls through to the env var", async () => {
    process.env[DROPBOX_ENV] = "from-env";
    await bind({ [DROPBOX_ID]: { clientId: "cid", clientSecret: "" } });
    expect(instanceOperatorApp(DROPBOX_ID)?.clientSecret).toBe("from-env");
  });

  test("throws when a declared app has no secret anywhere", async () => {
    await expect(bind({ [DROPBOX_ID]: { clientId: "cid" } })).rejects.toThrow(DROPBOX_ENV);
  });

  test("throws when a declared app has no client id", async () => {
    await expect(bind({ [DROPBOX_ID]: { clientSecret: "sec" } })).rejects.toThrow("clientId");
  });

  test("leaves an id that is not a static catalog entry unbound", async () => {
    await bind({
      "com.notion/mcp": { clientId: "cid", clientSecret: "sec" },
      "com.example/absent": { clientId: "cid", clientSecret: "sec" },
    });
    expect(instanceOperatorApp("com.notion/mcp")).toBeUndefined();
    expect(instanceOperatorApp("com.example/absent")).toBeUndefined();
  });

  test("does not read the catalog when nothing is declared", async () => {
    let read = false;
    await bindInstanceOperatorApps(async () => {
      read = true;
      return new Map();
    });
    expect(read).toBe(false);
  });
});

describe("resolveStaticOAuthClient for an instance app", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-operator-apps-"));
    installTestCredentialStore(workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const instanceRef = (url = DROPBOX_URL): ConnectorRef => ({
    url,
    serverName: "com-dropbox-mcp",
    oauthClient: { instanceApp: DROPBOX_ID },
  });

  test("resolves the operator's current id and secret, with no workspace", async () => {
    await bind({ [DROPBOX_ID]: { clientId: "cid", clientSecret: "sec" } });
    expect(await resolveStaticOAuthClient({ ref: instanceRef() })).toEqual({
      clientId: "cid",
      clientSecret: "sec",
    });
  });

  test("refuses a ref whose URL is not the one the app is bound to", async () => {
    await bind({ [DROPBOX_ID]: { clientId: "cid", clientSecret: "sec" } });
    await expect(
      resolveStaticOAuthClient({ ref: instanceRef("https://evil.example/mcp") }),
    ).rejects.toThrow("serves https://mcp.dropbox.com/mcp");
  });

  test("refuses when the operator no longer declares the app", async () => {
    await expect(resolveStaticOAuthClient({ ref: instanceRef() })).rejects.toThrow(
      "connectors.operatorApps",
    );
  });

  test("a workspace's own app still needs a workspace to read its secret from", async () => {
    const ref: ConnectorRef = {
      url: DROPBOX_URL,
      serverName: "com-dropbox-mcp",
      oauthClient: { clientId: "cid", clientSecret: { ref: "credential", key: "k" } },
    };
    await expect(resolveStaticOAuthClient({ ref })).rejects.toThrow("no workspace");
  });
});
