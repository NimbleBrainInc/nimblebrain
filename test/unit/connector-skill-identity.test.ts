import { describe, expect, it } from "bun:test";
import {
  connectorSkillIdentity,
  type ServerDetail,
} from "../../src/connectors/server-detail.ts";

function detail(over: Partial<ServerDetail> = {}): ServerDetail {
  return { name: "example-server", description: "d", version: "1.0.0", ...over };
}

describe("connectorSkillIdentity", () => {
  it("derives the flat toolkit slug for Composio connectors", () => {
    const d = detail({
      name: "Gmail (Composio)",
      _meta: {
        "ai.nimblebrain/connector": { auth: "composio", composio: { toolkit: "gmail", authConfigEnv: "AC" } },
      },
    });
    expect(connectorSkillIdentity(d)).toBe("gmail");
  });

  it("derives the connector slug from the server name for non-Composio connectors", () => {
    expect(connectorSkillIdentity(detail({ name: "com.notion/mcp" }))).toBe("notion");
    expect(connectorSkillIdentity(detail({ name: "app.linear/mcp" }))).toBe("linear");
  });

  it("returns the name unchanged when there is no dotted prefix and no toolkit", () => {
    const d = detail({
      name: "weird",
      _meta: {
        "ai.nimblebrain/connector": { auth: "composio", composio: { toolkit: "   ", authConfigEnv: "AC" } },
      },
    });
    expect(connectorSkillIdentity(d)).toBe("weird");
  });

  it("derives <org> (not <server>) for io.github.<org>/<server> — documented limitation", () => {
    // The slug rule takes the LAST dotted label before the path, so the
    // registry-standard io.github.<org>/<server> form yields <org>. Harmless
    // today (overlays are curated first-party + opt-in; a wrong slug 404s and
    // the connector still installs). Pinned so a future change is conscious —
    // see the connectorSkillIdentityFrom doc comment.
    expect(connectorSkillIdentity(detail({ name: "io.github.acme/widget" }))).toBe("acme");
  });
});
