/**
 * Boot-time audit of Composio auth-config wiring.
 *
 * `authConfigs` is keyed by the catalog's `composio.toolkit`, matched exactly
 * across two repos — the runtime's catalog and the deployment's config. That is
 * the one coupling this design narrowed rather than removed: a mistyped key
 * resolves to nothing and surfaces at connect time, long after the edit.
 *
 * Resolution is lazy — it runs per install, connect, and probe — so nothing on
 * that path can see a key that names no toolkit. This walks the catalog once at
 * boot instead.
 *
 * It deliberately does **not** report toolkits with no id. The catalog is a menu,
 * not a manifest: a deployment wires the toolkits it wants and leaves the rest,
 * so "no id" is a choice, not a misconfiguration. Install already fails at the
 * moment it matters, naming the toolkit and the config key. Reporting it here
 * would mean a permanent boot warning listing most of the catalog — which is how
 * operators learn to ignore `[composio]` warnings, taking the useful arm down
 * with it.
 *
 * The remaining arm is self-gating: it fires only when a declared block names
 * something the catalog doesn't, so a deployment with no Composio wiring at all
 * produces no output.
 *
 * That arm asserts a *negative* — "this key names no toolkit" — so it is only
 * sound over a catalog that actually loaded. `catalogEntries()` isolates a failed
 * source into an `errors` array it then discards, and a static source with no
 * resolved path is skipped outright, so a mis-set mount is indistinguishable from
 * a genuinely toolkit-free catalog. It would report every declared key as a typo
 * at exactly the moment the operator is diagnosing an empty Browse, and the
 * remedy it names is to edit correct config. The arm therefore requires at least
 * one catalog toolkit to compare against; `warnIfCuratedCatalogEmpty` owns the
 * empty-catalog diagnosis.
 */

import { log } from "../../../observability/log.ts";
import type { ConnectorCatalogEntry } from "../../../registries/projection.ts";
import { declaredProviderConfig } from "../config.ts";

export interface ComposioAuthConfigAudit {
  /** Declared toolkits that name a real catalog entry. */
  declared: string[];
  /**
   * Declared keys matching no `auth: composio` catalog toolkit — typos or
   * leftovers. Always empty when the catalog names no composio toolkit at all,
   * because a catalog that failed to load matches nothing either.
   */
  orphanedKeys: string[];
}

/** Every `auth: composio` toolkit the catalog declares. */
function catalogToolkits(entries: ConnectorCatalogEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (entry.auth === "composio" && entry.composio) out.add(entry.composio.toolkit);
  }
  return out;
}

/**
 * Split the declared `authConfigs` keys into those naming a real catalog toolkit
 * and those naming nothing. Pure: no logging, no side effects — the reporting is
 * the caller's.
 */
export function auditComposioAuthConfigs(
  entries: ConnectorCatalogEntry[],
): ComposioAuthConfigAudit {
  const audit: ComposioAuthConfigAudit = { declared: [], orphanedKeys: [] };
  const known = catalogToolkits(entries);

  // Only meaningful against a catalog that loaded — see the module header.
  if (known.size === 0) return audit;

  for (const [key, value] of Object.entries(
    declaredProviderConfig("composio")?.authConfigs ?? {},
  )) {
    // A blank id is not a declaration — matching what resolution does with one.
    if (!value?.trim()) continue;
    if (known.has(key)) audit.declared.push(key);
    else audit.orphanedKeys.push(key);
  }

  return audit;
}

/**
 * Boot wrapper: audit the catalog and report. Swallows any failure — a wiring
 * report must never keep the runtime from starting. This is the seam
 * `Runtime.start` calls.
 */
export async function bootAuditComposioAuthConfigs(deps: {
  catalogEntries: () => Promise<ConnectorCatalogEntry[]>;
}): Promise<void> {
  try {
    const audit = auditComposioAuthConfigs(await deps.catalogEntries());

    if (audit.orphanedKeys.length > 0) {
      log.warn(
        "[composio] connectors.providers.composio.authConfigs names " +
          `${audit.orphanedKeys.length} toolkit(s) absent from the catalog: ` +
          `${audit.orphanedKeys.join(", ")}. Each is either a typo — the key must match a ` +
          "catalog entry's composio.toolkit exactly — or a leftover from a removed connector.",
      );
    }

    if (audit.declared.length > 0) {
      log.info(`[composio] ${audit.declared.length} toolkit(s) wired via authConfigs.`);
    }
  } catch (err) {
    log.warn(
      `[composio] auth-config audit failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
