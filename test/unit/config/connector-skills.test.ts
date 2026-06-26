import { describe, expect, it } from "bun:test";
import {
  CONNECTOR_SKILLS_REPO_DEFAULT,
  CONNECTOR_SKILLS_VERSION_DEFAULT,
  resolveConnectorSkillsConfig,
} from "../../../src/config/connector-skills.ts";

describe("resolveConnectorSkillsConfig", () => {
  it("falls back to the pinned repo/version by default", () => {
    const cfg = resolveConnectorSkillsConfig({});
    expect(cfg.repo).toBe(CONNECTOR_SKILLS_REPO_DEFAULT);
    expect(cfg.version).toBe(CONNECTOR_SKILLS_VERSION_DEFAULT);
  });

  it("overrides repo/version when set, falling back to defaults on blank", () => {
    const cfg = resolveConnectorSkillsConfig({
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
