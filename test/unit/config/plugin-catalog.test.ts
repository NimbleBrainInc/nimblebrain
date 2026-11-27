import { describe, expect, it } from "bun:test";
import {
  PLUGIN_CATALOG_CONNECTORS_SHA256_DEFAULT,
  PLUGIN_CATALOG_SHA256_DEFAULT,
  PLUGIN_CATALOG_URL_DEFAULT,
  resolvePluginCatalogConfig,
  retiredConnectorSkillsEnv,
} from "../../../src/config/plugin-catalog.ts";

const PIN = "a".repeat(64);

describe("resolvePluginCatalogConfig", () => {
  it("defaults to NimbleBrain's catalog at the compiled pin", () => {
    expect(resolvePluginCatalogConfig({})).toEqual({
      url: PLUGIN_CATALOG_URL_DEFAULT,
      sha256: PLUGIN_CATALOG_SHA256_DEFAULT,
      connectorsSha256: PLUGIN_CATALOG_CONNECTORS_SHA256_DEFAULT,
    });
    expect(PLUGIN_CATALOG_SHA256_DEFAULT).toMatch(/^[0-9a-f]{64}$/);
    expect(PLUGIN_CATALOG_CONNECTORS_SHA256_DEFAULT).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes the operator's catalog and pins, trimming a trailing slash", () => {
    const cfg = resolvePluginCatalogConfig({
      NB_PLUGIN_CATALOG_URL: "https://catalog.example/",
      NB_PLUGIN_CATALOG_SHA256: PIN.toUpperCase(),
      NB_PLUGIN_CATALOG_CONNECTORS_SHA256: "b".repeat(64),
    });
    expect(cfg).toEqual({
      url: "https://catalog.example",
      sha256: PIN,
      connectorsSha256: "b".repeat(64),
    });
  });

  it("treats blank values as unset", () => {
    const cfg = resolvePluginCatalogConfig({
      NB_PLUGIN_CATALOG_URL: "  ",
      NB_PLUGIN_CATALOG_SHA256: "",
    });
    expect(cfg.url).toBe(PLUGIN_CATALOG_URL_DEFAULT);
    expect(cfg.sha256).toBe(PLUGIN_CATALOG_SHA256_DEFAULT);
  });

  it("refuses a pin that is not a sha256, such as a tag", () => {
    expect(() => resolvePluginCatalogConfig({ NB_PLUGIN_CATALOG_SHA256: "v0.5.0" })).toThrow(
      /sha256/,
    );
    expect(() =>
      resolvePluginCatalogConfig({ NB_PLUGIN_CATALOG_CONNECTORS_SHA256: "latest" }),
    ).toThrow(/NB_PLUGIN_CATALOG_CONNECTORS_SHA256/);
  });
});

describe("retiredConnectorSkillsEnv", () => {
  it("names the connector-skills settings that are set, to warn they are ignored", () => {
    expect(retiredConnectorSkillsEnv({})).toEqual([]);
    expect(
      retiredConnectorSkillsEnv({ CONNECTOR_SKILLS_REPO: "acme/x", CONNECTOR_SKILLS_VERSION: " " }),
    ).toEqual(["CONNECTOR_SKILLS_REPO"]);
  });
});
