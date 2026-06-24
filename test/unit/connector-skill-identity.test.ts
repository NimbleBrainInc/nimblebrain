import { describe, expect, it } from "bun:test";
import {
  connectorSkillIdentity,
  type ServerDetail,
} from "../../src/connectors/server-detail.ts";

function detail(over: Partial<ServerDetail> = {}): ServerDetail {
  return { name: "example-server", description: "d", version: "1.0.0", ...over };
}

describe("connectorSkillIdentity", () => {
  it("derives composio/<toolkit> for Composio connectors", () => {
    const d = detail({
      name: "Gmail (Composio)",
      _meta: {
        "ai.nimblebrain/connector": { auth: "composio", composio: { toolkit: "gmail", authConfigEnv: "AC" } },
      },
    });
    expect(connectorSkillIdentity(d)).toBe("composio/gmail");
  });

  it("falls back to the server name for non-Composio connectors", () => {
    expect(connectorSkillIdentity(detail({ name: "io.github.acme/widget" }))).toBe(
      "io.github.acme/widget",
    );
  });

  it("falls back to the server name when the toolkit is blank", () => {
    const d = detail({
      name: "weird",
      _meta: {
        "ai.nimblebrain/connector": { auth: "composio", composio: { toolkit: "   ", authConfigEnv: "AC" } },
      },
    });
    expect(connectorSkillIdentity(d)).toBe("weird");
  });
});
