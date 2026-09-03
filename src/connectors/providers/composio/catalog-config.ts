/**
 * Composio's own reading of the catalog block an operator authors for it.
 *
 * The kernel hands a brokered provider the block under the key naming that
 * provider (`composio:` here) as an opaque `Record<string, unknown>` and reads
 * nothing out of it. This module is where that blob becomes Composio's typed
 * coordinates — the provider's boundary, not the kernel's.
 *
 * {@link ComposioConnectorConfig} in `connectors/server-detail.ts` remains the
 * declared shape for catalog authors and for the surfaces that render it (the
 * API-key form). This parser is deliberately defensive anyway: the value
 * reaching it came off a YAML file or a registry response, so a typed field is
 * a claim, not a fact.
 */

import type { ComposioConnectField, ComposioConnectorConfig } from "../../server-detail.ts";

/** Parse the catalog block, or return why it is unusable. */
export function parseComposioCatalogConfig(
  config: Record<string, unknown>,
): { config: ComposioConnectorConfig } | { error: string } {
  const toolkit = typeof config.toolkit === "string" ? config.toolkit.trim() : "";
  if (!toolkit) return { error: "composio config block is missing a `toolkit`." };

  const tools = Array.isArray(config.tools)
    ? config.tools.filter((t): t is string => typeof t === "string" && t.length > 0)
    : undefined;

  const authScheme = config.authScheme === "API_KEY" ? "API_KEY" : "OAUTH2";

  const fields = Array.isArray(config.fields)
    ? config.fields.filter(
        (f): f is ComposioConnectField =>
          !!f && typeof f === "object" && typeof (f as ComposioConnectField).key === "string",
      )
    : undefined;

  return {
    config: {
      toolkit,
      ...(tools && tools.length > 0 ? { tools } : {}),
      authScheme,
      ...(fields ? { fields } : {}),
    },
  };
}
