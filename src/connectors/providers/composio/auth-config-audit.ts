/**
 * Boot-time audit of Composio auth-config wiring.
 *
 * Resolution itself is lazy — `composioAuthConfigId` runs only when a connector
 * is installed, connected, or probed. That makes the per-toolkit deprecation
 * warning it emits a report on the *installed* subset, not on the catalog: a
 * toolkit nobody has installed yet is silent no matter how it is wired. Two
 * decisions need the catalog-wide view instead:
 *
 *   - **When is the legacy env fallback unused?** (#789) Dropping
 *     `composio.authConfigEnv` from the catalog removes the fallback's only
 *     trigger, so every toolkit still riding it has to be known *before* that
 *     change, not discovered afterwards by whoever installs one next.
 *   - **Does every declared key name a real toolkit?** `authConfigs` is keyed by
 *     the catalog's `composio.toolkit`, matched exactly across two repos. A
 *     mistyped key resolves to `""` and surfaces at connect time — the same
 *     silent miss that keying on an env-var name produced.
 *
 * So this walks the catalog once at boot and reports the whole picture. It is a
 * read-only report: nothing here changes resolution, and a failure never breaks
 * boot.
 */

import { log } from "../../../observability/log.ts";
import type { ConnectorCatalogEntry } from "../../../registries/projection.ts";
import { declaredProviderConfig } from "../config.ts";
import { markAuthConfigEnvReported } from "./config.ts";

export interface ComposioAuthConfigAudit {
  /** Toolkits whose id comes from the declared block — the destination state. */
  declared: string[];
  /** Toolkits still resolving from the legacy env var, with the var's name. */
  fromEnv: { toolkit: string; envVar: string }[];
  /** Toolkits with no id anywhere — installs and connects will fail. */
  unresolved: string[];
  /** Declared keys matching no `auth: composio` catalog toolkit — typos or leftovers. */
  orphanedKeys: string[];
}

/** The `composio` block of every `auth: composio` entry, in catalog order. */
function* composioConfigs(
  entries: ConnectorCatalogEntry[],
): Generator<NonNullable<ConnectorCatalogEntry["composio"]>> {
  for (const entry of entries) {
    if (entry.auth === "composio" && entry.composio) yield entry.composio;
  }
}

/**
 * Classify every `auth: composio` catalog entry against the declared block.
 * Pure: no logging, no resolution side effects — the reporting is the caller's.
 */
export function auditComposioAuthConfigs(
  entries: ConnectorCatalogEntry[],
): ComposioAuthConfigAudit {
  const declaredBlock = declaredProviderConfig("composio")?.authConfigs ?? {};
  const audit: ComposioAuthConfigAudit = {
    declared: [],
    fromEnv: [],
    unresolved: [],
    orphanedKeys: [],
  };

  const catalogToolkits = new Set<string>();
  for (const composio of composioConfigs(entries)) {
    const { toolkit, authConfigEnv } = composio;
    // One entry per toolkit, not per catalog entry: two entries may legitimately
    // share a toolkit, and the wiring question is about the toolkit.
    if (catalogToolkits.has(toolkit)) continue;
    catalogToolkits.add(toolkit);

    if (declaredBlock[toolkit]?.trim()) {
      audit.declared.push(toolkit);
    } else if (authConfigEnv && process.env[authConfigEnv]?.trim()) {
      audit.fromEnv.push({ toolkit, envVar: authConfigEnv });
    } else {
      audit.unresolved.push(toolkit);
    }
  }

  for (const key of Object.keys(declaredBlock)) {
    if (!catalogToolkits.has(key)) audit.orphanedKeys.push(key);
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

    if (audit.fromEnv.length > 0) {
      // Suppress the lazy per-toolkit warning for everything named here, so the
      // same deprecation isn't reported twice in two shapes.
      for (const { toolkit } of audit.fromEnv) markAuthConfigEnvReported(toolkit);
      log.warn(
        `[composio] ${audit.fromEnv.length} toolkit(s) resolve their auth config id from the ` +
          "deprecated environment fallback: " +
          audit.fromEnv.map(({ toolkit, envVar }) => `${toolkit} (${envVar})`).join(", ") +
          ". Move each to connectors.providers.composio.authConfigs in nimblebrain.json; " +
          "this fallback is slated for removal (#789).",
      );
    }

    if (audit.unresolved.length > 0) {
      log.warn(
        `[composio] ${audit.unresolved.length} catalog toolkit(s) have no auth config id and ` +
          `cannot be installed: ${audit.unresolved.join(", ")}. Set ` +
          "connectors.providers.composio.authConfigs.<toolkit> for each.",
      );
    }

    if (audit.orphanedKeys.length > 0) {
      log.warn(
        "[composio] connectors.providers.composio.authConfigs names " +
          `${audit.orphanedKeys.length} toolkit(s) absent from the catalog: ` +
          `${audit.orphanedKeys.join(", ")}. Each is either a typo — the key must match a ` +
          "catalog entry's composio.toolkit exactly — or a leftover from a removed connector.",
      );
    }

    if (audit.declared.length > 0 && audit.fromEnv.length === 0) {
      log.info(
        `[composio] ${audit.declared.length} toolkit(s) wired via authConfigs; ` +
          "none on the deprecated environment fallback.",
      );
    }
  } catch (err) {
    log.warn(
      `[composio] auth-config audit failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
