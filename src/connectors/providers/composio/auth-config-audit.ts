/**
 * Boot-time audit of Composio auth-config wiring.
 *
 * Resolution is lazy — `resolveComposioAuthConfig` runs only when a connector is
 * installed, connected, or probed, so nothing on that path can describe a
 * toolkit nobody has installed. Two decisions need the catalog-wide view:
 *
 *   - **When is the legacy env fallback unused?** (#789) Dropping
 *     `composio.authConfigEnv` from the catalog removes the fallback's only
 *     trigger, so every toolkit still riding it has to be known *before* that
 *     change, not discovered afterwards by whoever installs one next.
 *   - **Does every declared key name a real toolkit?** `authConfigs` is keyed by
 *     the catalog's `composio.toolkit`, matched exactly across two repos. A
 *     mistyped key resolves to nothing and surfaces at connect time — the one
 *     coupling this design narrowed rather than removed.
 *
 * It deliberately does **not** report toolkits with no id. The catalog is a menu,
 * not a manifest: a deployment wires the toolkits it wants and leaves the rest,
 * so "no id" is a choice, not a misconfiguration. Install already fails at the
 * moment it matters, naming the toolkit and the config key. Reporting it here
 * would mean a permanent boot warning listing most of the catalog — which is how
 * operators learn to ignore `[composio]` warnings, taking the two actionable
 * arms down with it.
 *
 * Both arms are therefore self-gating: a deployment with no Composio wiring at
 * all produces no output, matching the revalidator's "dormant unless a provider
 * contributes a probe".
 */

import { log } from "../../../observability/log.ts";
import type { ConnectorCatalogEntry } from "../../../registries/projection.ts";
import { declaredProviderConfig } from "../config.ts";
import { resolveComposioAuthConfig } from "./config.ts";

export interface ComposioAuthConfigAudit {
  /** Toolkits whose id comes from the declared block — the destination state. */
  declared: string[];
  /** Toolkits still resolving from the legacy env var, with the var that supplied it. */
  fromEnv: { toolkit: string; envVar: string }[];
  /** Declared keys matching no `auth: composio` catalog toolkit — typos or leftovers. */
  orphanedKeys: string[];
}

/**
 * Every `auth: composio` toolkit in the catalog, mapped to the legacy env vars
 * its entries name.
 *
 * Grouped by toolkit rather than walked per entry because two entries may front
 * the same toolkit, and the wiring question is about the toolkit. Taking the
 * first entry would make classification depend on catalog order — an entry that
 * omits `authConfigEnv` could hide a toolkit still riding the fallback, which is
 * the exact input #789 turns on.
 */
function toolkitEnvVars(entries: ConnectorCatalogEntry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.auth !== "composio" || !entry.composio) continue;
    const { toolkit, authConfigEnv } = entry.composio;
    const vars = out.get(toolkit) ?? [];
    if (authConfigEnv && !vars.includes(authConfigEnv)) vars.push(authConfigEnv);
    out.set(toolkit, vars);
  }
  return out;
}

/**
 * Classify every `auth: composio` catalog toolkit against the declared block.
 * Pure: no logging, no side effects — the reporting is the caller's.
 *
 * Classification runs through `resolveComposioAuthConfig` rather than restating
 * its precedence, so the audit cannot drift from what installs actually resolve.
 */
export function auditComposioAuthConfigs(
  entries: ConnectorCatalogEntry[],
): ComposioAuthConfigAudit {
  const audit: ComposioAuthConfigAudit = { declared: [], fromEnv: [], orphanedKeys: [] };
  const byToolkit = toolkitEnvVars(entries);

  for (const [toolkit, envVars] of byToolkit) {
    if (resolveComposioAuthConfig(toolkit).source === "declared") {
      audit.declared.push(toolkit);
      continue;
    }
    // Any of the toolkit's entries may name the var that carries the value, so
    // scan them all — taking only the first would make the result depend on
    // catalog order.
    const envVar = envVars.find((v) => resolveComposioAuthConfig(toolkit, v).source === "env");
    if (envVar) audit.fromEnv.push({ toolkit, envVar });
  }

  for (const key of Object.keys(declaredProviderConfig("composio")?.authConfigs ?? {})) {
    if (!byToolkit.has(key)) audit.orphanedKeys.push(key);
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
      log.warn(
        `[composio] ${audit.fromEnv.length} toolkit(s) resolve their auth config id from the ` +
          "deprecated environment fallback: " +
          audit.fromEnv.map(({ toolkit, envVar }) => `${toolkit} (${envVar})`).join(", ") +
          ". Move each to connectors.providers.composio.authConfigs in nimblebrain.json; " +
          "this fallback is slated for removal (#789).",
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
