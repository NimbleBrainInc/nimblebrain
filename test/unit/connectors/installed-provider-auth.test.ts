import { describe, expect, test } from "bun:test";
import { installedProviderAuth } from "../../../src/tools/connector-tools.ts";

// A minted fleet connector's credential settings come from its catalog entry at
// every connection build, so its install stores none; other providers read
// their config from the stored ref and keep it.
describe("installedProviderAuth", () => {
  test("a minted fleet connector stores its provider and no credential settings", () => {
    expect(
      installedProviderAuth({
        provider: "minted",
        config: { audience: "mcp-alpha", scope: "mcp:invoke" },
      }),
    ).toEqual({ type: "provider", provider: "minted", config: {} });
  });

  test("another provider stores its config as the catalog entry gives it", () => {
    const config = { key: "tenant-a.api_key" };
    expect(installedProviderAuth({ provider: "credential", config })).toEqual({
      type: "provider",
      provider: "credential",
      config,
    });
  });
});
