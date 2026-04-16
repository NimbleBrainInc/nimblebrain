/**
 * Core resource registry — maps resource paths to self-contained HTML pages.
 *
 * Each resource is rendered via the Shell component (render.tsx) with
 * per-resource styles and a client-side script that uses the lightweight
 * postMessage bridge to call tools and navigate.
 */

import { renderResource } from "./render.tsx";
import { APP_NAV_SCRIPT } from "./scripts/app-nav.ts";
import { CONVERSATIONS_SCRIPT } from "./scripts/conversations.ts";
import { HOME_BRIEFING_INLINE_SCRIPT } from "./scripts/home-briefing-inline.ts";
import { HOME_DASHBOARD_SCRIPT } from "./scripts/home-dashboard.ts";
import { MODEL_SELECTOR_SCRIPT } from "./scripts/model-selector.ts";
import { SETTINGS_SCRIPT } from "./scripts/settings.ts";
import { SETTINGS_LINK_SCRIPT } from "./scripts/settings-link.ts";
import { USAGE_BAR_SCRIPT } from "./scripts/usage-bar.ts";
import { USAGE_DASHBOARD_SCRIPT } from "./scripts/usage-dashboard.ts";
import {
  APP_NAV_STYLES,
  CONVERSATIONS_STYLES,
  HOME_BRIEFING_INLINE_STYLES,
  HOME_DASHBOARD_STYLES,
  MODEL_SELECTOR_STYLES,
  SETTINGS_LINK_STYLES,
  SETTINGS_STYLES,
  USAGE_BAR_STYLES,
  USAGE_DASHBOARD_STYLES,
} from "./styles.ts";

const resources: Record<string, () => string> = {
  conversations: () => renderResource(CONVERSATIONS_STYLES, CONVERSATIONS_SCRIPT),
  "app-nav": () => renderResource(APP_NAV_STYLES, APP_NAV_SCRIPT),
  "settings-link": () => renderResource(SETTINGS_LINK_STYLES, SETTINGS_LINK_SCRIPT),
  "usage-bar": () => renderResource(USAGE_BAR_STYLES, USAGE_BAR_SCRIPT),
  "usage-dashboard": () => renderResource(USAGE_DASHBOARD_STYLES, USAGE_DASHBOARD_SCRIPT),
  settings: () => renderResource(SETTINGS_STYLES, SETTINGS_SCRIPT),
  "model-selector": () => renderResource(MODEL_SELECTOR_STYLES, MODEL_SELECTOR_SCRIPT),
  "home-dashboard": () => renderResource(HOME_DASHBOARD_STYLES, HOME_DASHBOARD_SCRIPT),
  "home-briefing-inline": () =>
    renderResource(HOME_BRIEFING_INLINE_STYLES, HOME_BRIEFING_INLINE_SCRIPT),
};

/**
 * Get an HTML resource by path name.
 * Returns the HTML string or null if the resource does not exist.
 */
export function getCoreResource(path: string): string | null {
  const factory = resources[path];
  return factory ? factory() : null;
}

/**
 * Build a Map of all core resources for use with InlineSource.
 * Keys are resource paths, values are rendered HTML strings.
 */
export function buildCoreResourceMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [path, factory] of Object.entries(resources)) {
    map.set(path, factory());
  }
  return map;
}
