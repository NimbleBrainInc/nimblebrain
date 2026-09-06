import { describe, expect, test } from "bun:test";
import {
  assertConnectorRefIsPostStage2,
  LegacyOAuthScopeError,
} from "../../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";

/**
 * Disk-read boundary contract: Stage 2 cut the legacy
 * `oauthScope: "user"` literal from the schema. Operators run
 * `bun run migrate:user-creds` before deploying Stage 2; the runtime
 * does NOT translate or normalize legacy data at boot. A skipped
 * migration is operator error and surfaces here as a hard error
 * naming the offending record. See the deploy runbook at
 * the Stage 2 deploy runbook.
 */
describe("assertConnectorRefIsPostStage2", () => {
  test("throws LegacyOAuthScopeError on a URL connector carrying oauthScope: 'user'", () => {
    // Cast through unknown to simulate what JSON.parse leaves on disk
    // for a record persisted before Stage 2.
    const legacy = {
      url: "https://granola.so/mcp",
      serverName: "granola",
      oauthScope: "user",
    } as unknown as ConnectorRef;
    expect(() => assertConnectorRefIsPostStage2(legacy)).toThrow(LegacyOAuthScopeError);
  });

  test("LegacyOAuthScopeError surfaces the connector name and disk URL for operator triage", () => {
    const legacy = {
      url: "https://granola.so/mcp",
      serverName: "granola",
      oauthScope: "user",
    } as unknown as ConnectorRef;
    try {
      assertConnectorRefIsPostStage2(legacy);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LegacyOAuthScopeError);
      const e = err as LegacyOAuthScopeError;
      expect(e.serverName).toBe("granola");
      expect(e.url).toBe("https://granola.so/mcp");
      // The message must name the recovery command operators copy-paste.
      // We pin that stable identifier only — NOT the surrounding prose.
      expect(e.message).toContain("migrate:user-creds");
    }
  });

  test("accepts a URL connector with oauthScope: 'workspace'", () => {
    const ok: ConnectorRef = {
      url: "https://example.test/mcp",
      serverName: "example",
      oauthScope: "workspace",
    };
    expect(() => assertConnectorRefIsPostStage2(ok)).not.toThrow();
  });

  test("accepts a URL connector with no oauthScope (default)", () => {
    const ok: ConnectorRef = {
      url: "https://example.test/mcp",
      serverName: "example",
    };
    expect(() => assertConnectorRefIsPostStage2(ok)).not.toThrow();
  });

  test("accepts non-URL refs unchanged (named, local-path) — oauthScope only applies to URL connectors", () => {
    const named: ConnectorRef = { name: "@scope/some-connector" };
    expect(() => assertConnectorRefIsPostStage2(named)).not.toThrow();

    const local: ConnectorRef = { path: "/tmp/some/path" };
    expect(() => assertConnectorRefIsPostStage2(local)).not.toThrow();
  });

  test("falls back to '(unknown)' server name when the legacy ref lacks one", () => {
    const legacy = {
      url: "https://example.test/mcp",
      oauthScope: "user",
    } as unknown as ConnectorRef;
    try {
      assertConnectorRefIsPostStage2(legacy);
      throw new Error("expected throw");
    } catch (err) {
      const e = err as LegacyOAuthScopeError;
      expect(e.serverName).toBe("(unknown)");
      expect(e.url).toBe("https://example.test/mcp");
    }
  });
});
