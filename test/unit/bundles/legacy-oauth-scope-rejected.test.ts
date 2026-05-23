import { describe, expect, test } from "bun:test";
import {
  assertBundleRefIsPostStage2,
  LegacyOAuthScopeError,
} from "../../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";

/**
 * Disk-read boundary contract: Stage 2 cut the legacy
 * `oauthScope: "user"` literal from the schema. Operators run
 * `bun run migrate:user-creds` before deploying Stage 2; the runtime
 * does NOT translate or normalize legacy data at boot. A skipped
 * migration is operator error and surfaces here as a hard error
 * naming the offending record. See the deploy runbook at
 * `nimblebrain-ops/research/delegation-model/STAGE_2_DEPLOY.md`.
 */
describe("assertBundleRefIsPostStage2", () => {
  test("throws LegacyOAuthScopeError on a URL bundle carrying oauthScope: 'user'", () => {
    // Cast through unknown to simulate what JSON.parse leaves on disk
    // for a record persisted before Stage 2.
    const legacy = {
      url: "https://granola.so/mcp",
      serverName: "granola",
      oauthScope: "user",
    } as unknown as BundleRef;
    expect(() => assertBundleRefIsPostStage2(legacy)).toThrow(LegacyOAuthScopeError);
  });

  test("LegacyOAuthScopeError surfaces the bundle name and disk URL for operator triage", () => {
    const legacy = {
      url: "https://granola.so/mcp",
      serverName: "granola",
      oauthScope: "user",
    } as unknown as BundleRef;
    try {
      assertBundleRefIsPostStage2(legacy);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LegacyOAuthScopeError);
      const e = err as LegacyOAuthScopeError;
      expect(e.serverName).toBe("granola");
      expect(e.url).toBe("https://granola.so/mcp");
      // Message must name the operator-facing migration command and the
      // deploy runbook so the failure mode is self-diagnosable.
      expect(e.message).toContain("migrate:user-creds");
      expect(e.message).toContain("STAGE_2_DEPLOY.md");
    }
  });

  test("accepts a URL bundle with oauthScope: 'workspace'", () => {
    const ok: BundleRef = {
      url: "https://example.test/mcp",
      serverName: "example",
      oauthScope: "workspace",
    };
    expect(() => assertBundleRefIsPostStage2(ok)).not.toThrow();
  });

  test("accepts a URL bundle with no oauthScope (default)", () => {
    const ok: BundleRef = {
      url: "https://example.test/mcp",
      serverName: "example",
    };
    expect(() => assertBundleRefIsPostStage2(ok)).not.toThrow();
  });

  test("accepts non-URL refs unchanged (named, local-path) — oauthScope only applies to URL bundles", () => {
    const named: BundleRef = { name: "@scope/some-bundle" };
    expect(() => assertBundleRefIsPostStage2(named)).not.toThrow();

    const local: BundleRef = { path: "/tmp/some/path" };
    expect(() => assertBundleRefIsPostStage2(local)).not.toThrow();
  });

  test("falls back to '(unknown)' server name when the legacy ref lacks one", () => {
    const legacy = {
      url: "https://example.test/mcp",
      oauthScope: "user",
    } as unknown as BundleRef;
    try {
      assertBundleRefIsPostStage2(legacy);
      throw new Error("expected throw");
    } catch (err) {
      const e = err as LegacyOAuthScopeError;
      expect(e.serverName).toBe("(unknown)");
      expect(e.url).toBe("https://example.test/mcp");
    }
  });
});
