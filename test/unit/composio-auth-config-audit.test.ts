/**
 * The catalog-wide Composio auth-config audit.
 *
 * Its reason to exist is that resolution is lazy: `composioAuthConfigId` runs
 * per install / connect / probe, so the deprecation warning it emits describes
 * the *installed* subset. Two decisions need the catalog instead — declaring the
 * legacy env fallback unused (#789), and catching an `authConfigs` key that
 * names no toolkit. Both are silent-until-too-late without this pass, so the
 * classification is covered directly rather than through a boot harness.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  auditComposioAuthConfigs,
  type ComposioAuthConfigAudit,
} from "../../src/connectors/providers/composio/auth-config-audit.ts";
import {
  _resetConnectorsConfigForTest,
  setConnectorsConfig,
} from "../../src/connectors/providers/config.ts";
import type { ConnectorCatalogEntry } from "../../src/registries/projection.ts";

const ENV_KEYS = ["COMPOSIO_GMAIL_AUTH_CONFIG_ID", "COMPOSIO_SLACK_AUTH_CONFIG_ID"] as const;
let saved: Record<string, string | undefined>;

/** Minimal catalog entry — only the fields the audit reads. */
function entry(
  id: string,
  auth: ConnectorCatalogEntry["auth"],
  composio?: { toolkit: string; authConfigEnv?: string },
): ConnectorCatalogEntry {
  return { id, name: id, auth, composio } as unknown as ConnectorCatalogEntry;
}

/**
 * Install a declared block.
 *
 * (Named `declareComposio`, not `declare` — a function named `declare` parses as
 * a TypeScript ambient declaration and silently never runs, leaving every
 * assertion about the declared block vacuously green.)
 */
function declareComposio(authConfigs: Record<string, string>): void {
  setConnectorsConfig({ providers: { composio: { authConfigs } } });
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  _resetConnectorsConfigForTest();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetConnectorsConfigForTest();
});

describe("auditComposioAuthConfigs", () => {
  it("reports a toolkit nobody has installed as still on the env fallback", () => {
    // The whole point. Lazy resolution never touches this toolkit, so its
    // deprecation would go unreported until someone tried to install it —
    // which, after the catalog drops authConfigEnv, is already too late.
    process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID = "ac_env";
    declareComposio({});

    const audit = auditComposioAuthConfigs([
      entry("com.slack/mcp", "composio", {
        toolkit: "slack",
        authConfigEnv: "COMPOSIO_SLACK_AUTH_CONFIG_ID",
      }),
    ]);

    expect(audit.fromEnv).toEqual([{ toolkit: "slack", envVar: "COMPOSIO_SLACK_AUTH_CONFIG_ID" }]);
    expect(audit.declared).toEqual([]);
  });

  it("separates declared, env-sourced, and unresolved toolkits in one pass", () => {
    process.env.COMPOSIO_SLACK_AUTH_CONFIG_ID = "ac_env";
    declareComposio({ gmail: "ac_declared" });

      const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", {
        toolkit: "gmail",
        authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
      }),
      entry("com.slack/mcp", "composio", {
        toolkit: "slack",
        authConfigEnv: "COMPOSIO_SLACK_AUTH_CONFIG_ID",
      }),
      entry("com.notion/mcp", "composio", { toolkit: "notion" }),
    ]);

    expect(audit.declared).toEqual(["gmail"]);
    expect(audit.fromEnv.map((e) => e.toolkit)).toEqual(["slack"]);
    expect(audit.unresolved).toEqual(["notion"]);
  });

  it("flags a declared key matching no catalog toolkit", () => {
    // The silent-miss this change was meant to eliminate, in its surviving
    // form: `authConfigs` is keyed by `composio.toolkit`, matched exactly
    // across two repos, so a typo resolves to "" at connect time.
    declareComposio({ gmial: "ac_typo", gmail: "ac_ok" });

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", { toolkit: "gmail" }),
    ]);

    expect(audit.orphanedKeys).toEqual(["gmial"]);
    expect(audit.declared).toEqual(["gmail"]);
  });

  it("prefers the declared id over a set env var, and reports it as declared", () => {
    // Mirrors resolution precedence: a migrated toolkit must not be reported as
    // still needing migration just because a stale var lingers in the pod.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({ gmail: "ac_declared" });

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", {
        toolkit: "gmail",
        authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
      }),
    ]);

    expect(audit.declared).toEqual(["gmail"]);
    expect(audit.fromEnv).toEqual([]);
  });

  it("ignores entries that are not auth: composio", () => {
    declareComposio({});
    const audit = auditComposioAuthConfigs([
      entry("com.linear/mcp", "dcr"),
      entry("com.stripe/mcp", "provider"),
    ]);

    expect(audit).toEqual({
      declared: [],
      fromEnv: [],
      unresolved: [],
      orphanedKeys: [],
    } satisfies ComposioAuthConfigAudit);
  });

  it("counts a toolkit once when two catalog entries share it", () => {
    // Two entries may legitimately front the same Composio toolkit; the wiring
    // question is per toolkit, so a duplicate would double-count the report.
    declareComposio({});
    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", { toolkit: "gmail" }),
      entry("com.google/gmail-alt", "composio", { toolkit: "gmail" }),
    ]);

    expect(audit.unresolved).toEqual(["gmail"]);
  });

  it("treats a blank declared id as absent, matching resolution", () => {
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({ gmail: "   " });

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", {
        toolkit: "gmail",
        authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
      }),
    ]);

    expect(audit.fromEnv.map((e) => e.toolkit)).toEqual(["gmail"]);
    expect(audit.declared).toEqual([]);
  });
});
