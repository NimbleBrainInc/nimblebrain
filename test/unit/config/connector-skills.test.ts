import { describe, expect, it } from "bun:test";
import {
  CONNECTOR_SKILLS_REPO_DEFAULT,
  CONNECTOR_SKILLS_VERSION_DEFAULT,
  resolveConnectorSkillsConfig,
} from "../../../src/config/connector-skills.ts";

describe("resolveConnectorSkillsConfig", () => {
  it("is opt-in: disabled by default with the pinned repo/version", () => {
    const cfg = resolveConnectorSkillsConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.repo).toBe(CONNECTOR_SKILLS_REPO_DEFAULT);
    expect(cfg.version).toBe(CONNECTOR_SKILLS_VERSION_DEFAULT);
  });

  it("enables only on an explicit truthy value (case/whitespace-insensitive)", () => {
    expect(resolveConnectorSkillsConfig({ CONNECTOR_SKILLS_ENABLED: "true" }).enabled).toBe(true);
    expect(resolveConnectorSkillsConfig({ CONNECTOR_SKILLS_ENABLED: "TRUE" }).enabled).toBe(true);
    expect(resolveConnectorSkillsConfig({ CONNECTOR_SKILLS_ENABLED: " 1 " }).enabled).toBe(true);
  });

  it("stays disabled (fail-closed) on a falsey or malformed value", () => {
    expect(resolveConnectorSkillsConfig({ CONNECTOR_SKILLS_ENABLED: "false" }).enabled).toBe(false);
    expect(resolveConnectorSkillsConfig({ CONNECTOR_SKILLS_ENABLED: "yes" }).enabled).toBe(false);
    expect(resolveConnectorSkillsConfig({ CONNECTOR_SKILLS_ENABLED: "" }).enabled).toBe(false);
  });

  it("overrides repo/version when set, falling back to defaults on blank", () => {
    const cfg = resolveConnectorSkillsConfig({
      CONNECTOR_SKILLS_ENABLED: "true",
      CONNECTOR_SKILLS_REPO: "acme/overlays",
      CONNECTOR_SKILLS_VERSION: "v2.3.4",
    });
    expect(cfg.repo).toBe("acme/overlays");
    expect(cfg.version).toBe("v2.3.4");

    const blank = resolveConnectorSkillsConfig({
      CONNECTOR_SKILLS_REPO: "   ",
      CONNECTOR_SKILLS_VERSION: "",
    });
    expect(blank.repo).toBe(CONNECTOR_SKILLS_REPO_DEFAULT);
    expect(blank.version).toBe(CONNECTOR_SKILLS_VERSION_DEFAULT);
  });
});
