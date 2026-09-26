/**
 * Core resource registry — maps resource paths to self-contained HTML pages.
 *
 * Each resource is rendered via the Shell component (render.tsx) with
 * per-resource styles and a client-side script that uses the lightweight
 * postMessage bridge to call tools.
 */

import { renderResource } from "./render.tsx";
import { MODEL_SELECTOR_SCRIPT } from "./scripts/model-selector.ts";
import { MODEL_SELECTOR_STYLES } from "./styles.ts";

const resources: Record<string, () => string> = {
  "model-selector": () => renderResource(MODEL_SELECTOR_STYLES, MODEL_SELECTOR_SCRIPT),
};

/**
 * Build a Map of all core resources for use with the `nb` in-process MCP
 * source. Keys are full `ui://nb/<path>` URIs — the form servers and
 * clients both use over the protocol — so lookups via
 * `client.readResource({ uri })` hit directly without a mapping layer.
 */
export function buildCoreResourceMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, factory] of Object.entries(resources)) {
    map.set(`ui://nb/${path}`, factory());
  }
  return map;
}
