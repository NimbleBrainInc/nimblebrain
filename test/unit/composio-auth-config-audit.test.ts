/**
 * The catalog-wide Composio auth-config audit.
 *
 * Its reason to exist is that resolution is lazy: `composioAuthConfigId` runs
 * per install / connect / probe, so it only ever sees the toolkits someone
 * asked for. A declared key that names *no* toolkit is therefore invisible
 * until a connect fails — and that key is the one string still shared between
 * the catalog and the deployment's config, so it is the failure worth catching
 * at boot.
 *
 * The classification is covered directly rather than through a boot harness.
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

/** Minimal catalog entry — only the fields the audit reads. */
function entry(
  id: string,
  auth: ConnectorCatalogEntry["auth"],
  composio?: { toolkit: string },
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

beforeEach(() => _resetConnectorsConfigForTest());
afterEach(() => _resetConnectorsConfigForTest());

describe("auditComposioAuthConfigs", () => {
  it("flags a declared key matching no catalog toolkit", () => {
    // The one coupling this design narrowed rather than removed: `authConfigs`
    // is keyed by `composio.toolkit`, matched exactly across two repos, so a
    // typo resolves to nothing and surfaces only at connect time.
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
      orphanedKeys: [],
    } satisfies ComposioAuthConfigAudit);

    // Still silent when the catalog loaded but carries no composio entries —
    // the same "nothing to compare against" state, reached a different way.
    expect(auditComposioAuthConfigs([entry("com.linear/mcp", "dcr")]).orphanedKeys).toEqual([]);
  });

  it("counts every declared toolkit the catalog knows", () => {
    declareComposio({ gmail: "ac_ok", notion: "ac_ok2" });

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", { toolkit: "gmail" }),
      entry("com.notion/mcp", "composio", { toolkit: "notion" }),
    ]);

    expect(audit.declared.sort()).toEqual(["gmail", "notion"]);
    expect(audit.orphanedKeys).toEqual([]);
  });

  it("says nothing about a catalog toolkit with no declared id", () => {
    // A deployment wires the toolkits it wants; the rest are a menu it
    // declined, not a misconfiguration. Install says so when it matters.
    declareComposio({ gmail: "ac_ok" });

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", { toolkit: "gmail" }),
      entry("com.notion/mcp", "composio", { toolkit: "notion" }),
    ]);

    expect(audit.declared).toEqual(["gmail"]);
    expect(audit.orphanedKeys).toEqual([]);
  });

  it("treats a blank declared id as absent, matching resolution", () => {
    declareComposio({ gmail: "   " });

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", { toolkit: "gmail" }),
    ]);

    expect(audit.declared).toEqual([]);
    expect(audit.orphanedKeys).toEqual([]);
  });

  it("counts a toolkit once when two catalog entries share it", () => {
    // Two entries may legitimately front the same toolkit; the wiring question
    // is per toolkit, so a duplicate would double-count the report.
    declareComposio({ gmail: "ac_ok" });

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", { toolkit: "gmail" }),
      entry("com.google/gmail-alt", "composio", { toolkit: "gmail" }),
    ]);

    expect(audit.declared).toEqual(["gmail"]);
  });

  it("ignores entries that are not auth: composio", () => {
    declareComposio({ gmail: "ac_ok" });

    const audit = auditComposioAuthConfigs([
      entry("com.linear/mcp", "dcr"),
      entry("com.stripe/mcp", "provider"),
    ]);

    expect(audit).toEqual({
      declared: [],
      orphanedKeys: [],
    } satisfies ComposioAuthConfigAudit);
  });

  it("reports nothing at all when no block is declared", () => {
    declareComposio({});

    const audit = auditComposioAuthConfigs([
      entry("com.google/gmail", "composio", { toolkit: "gmail" }),
    ]);

    expect(audit).toEqual({
      declared: [],
      orphanedKeys: [],
    } satisfies ComposioAuthConfigAudit);
  });
});
