/**
 * The catalog-wide Composio auth-config audit.
 *
 * Its reason to exist is that resolution is lazy: `composioAuthConfigId` runs
 * per install / connect / probe, so it only ever sees the *installed* subset.
 * Two decisions need the catalog instead — declaring the legacy env fallback
 * unused (#789), and catching an `authConfigs` key that names no toolkit. Both
 * are silent-until-too-late without this pass, so the classification is covered
 * directly rather than through a boot harness.
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
    // `notion` has no id anywhere and is deliberately absent from the report:
    // the catalog is a menu, and a toolkit this deployment chose not to wire is
    // not a misconfiguration. Install says so when it matters.
    expect(audit).not.toHaveProperty("unresolved");
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

  it("flags no orphans when the catalog names no composio toolkit", () => {
    // A catalog that failed to load matches nothing, exactly like a set of
    // mistyped keys does. `catalogEntries()` drops the per-source `errors` it
    // collects and skips a static source with no resolved path, so a mis-set
    // mount arrives here as an empty list — and calling every correct key a
    // typo would send the operator to edit working config while the real
    // problem (diagnosed by `warnIfCuratedCatalogEmpty`) is the mount.
    declareComposio({ gmail: "ac_1", outlook: "ac_2", posthog: "ac_3" });

    expect(auditComposioAuthConfigs([])).toEqual({
      declared: [],
      fromEnv: [],
      orphanedKeys: [],
    } satisfies ComposioAuthConfigAudit);

    // Still silent when the catalog loaded but carries no composio entries —
    // the same "nothing to compare against" state, reached a different way.
    expect(
      auditComposioAuthConfigs([entry("com.linear/mcp", "dcr")]).orphanedKeys,
    ).toEqual([]);
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
      orphanedKeys: [],
    } satisfies ComposioAuthConfigAudit);
  });

  it("classifies a shared toolkit the same way regardless of catalog order", () => {
    // Two entries may front the same toolkit, and only one may name the env var
    // that carries the id. Letting the first entry win would hide a toolkit
    // still riding the fallback — the exact input #789 turns on — and depend on
    // which entry the catalog happens to list first.
    process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID = "ac_env";
    declareComposio({});

    const named = entry("com.google/gmail", "composio", {
      toolkit: "gmail",
      authConfigEnv: "COMPOSIO_GMAIL_AUTH_CONFIG_ID",
    });
    const bare = entry("com.google/gmail-alt", "composio", { toolkit: "gmail" });

    for (const order of [
      [named, bare],
      [bare, named],
    ]) {
      const audit = auditComposioAuthConfigs(order);
      expect(audit.fromEnv).toEqual([
        { toolkit: "gmail", envVar: "COMPOSIO_GMAIL_AUTH_CONFIG_ID" },
      ]);
    }
  });

  it("reports a toolkit with no id anywhere in no arm at all", () => {
    // A deployment wires the toolkits it wants; the rest are a menu it declined.
    declareComposio({});
    const audit = auditComposioAuthConfigs([
      entry("com.notion/mcp", "composio", { toolkit: "notion" }),
    ]);

    expect(audit).toEqual({ declared: [], fromEnv: [], orphanedKeys: [] });
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
