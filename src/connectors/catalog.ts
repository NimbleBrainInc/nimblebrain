/**
 * Catalog of remote MCP connectors NimbleBrain knows about. Surfaces
 * to the Settings → Connectors page so users can install + connect
 * services with one click rather than editing `workspace.json` directly.
 *
 * Distribution model:
 *
 *   1. `catalog.yaml` (this directory) ships with the platform —
 *      curated by NimbleBrain, vetted entries, sensible scope hints.
 *      Read at boot via `loadCatalog()` (see `load-catalog.ts`).
 *   2. `NB_CATALOG_PATH` env var (optional) points at a YAML or JSON
 *      file (typically a Kubernetes ConfigMap) that **fully replaces**
 *      the default. Operators with custom needs ship their own catalog
 *      without an app release. Replace, not merge — see `load-catalog.ts`
 *      for the rationale.
 *   3. Per-workspace `connectorsAllowList` filter narrows the visible
 *      set (admin reads `workspace.json` to control which services a
 *      tenant sees on their Connectors page).
 *
 * Secrets stay OUT of the catalog. `auth: "static"` entries reference
 * the credential store via `operatorSetup.clientSecretKey` — the value
 * is set by the workspace admin via the Set up modal (writes through
 * `manage_connectors.setup_operator`) or, for headless deployments,
 * `nb credential set <wsId> <key> <value>`. Never lives in the catalog
 * ConfigMap.
 *
 * Icons hosted at `https://static.nimblebrain.ai/icons/<id>.svg` —
 * existing repo. Self-host deployments behind firewalls can override
 * via the catalog's `iconUrl` field (any absolute URL works).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A single entry in the connectors catalog. */
export interface ConnectorCatalogEntry {
  /**
   * Stable slug-like id. Persists across catalog edits and is used as
   * the primary key for `workspace.json#connectorsAllowList`,
   * Connectors-page UI keys, and the bundle's serverName. Must match
   * `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?` (lowercase, kebab) so it can
   * compose into URLs and filesystem paths without escaping.
   */
  id: string;
  /** Display name shown on the card. */
  name: string;
  /** One-line tagline. ~80 chars. */
  description: string;
  /** Absolute URL to the SVG icon (or relative if served from same origin). */
  iconUrl: string;
  /** Remote MCP server URL (the value that goes into bundle `url`). */
  url: string;
  /**
   * - `"dcr"` — Dynamic Client Registration (RFC 7591). The server
   *   exposes a `/register` endpoint and our provider auto-registers.
   *   Operator setup is zero. Granola, Notion.
   * - `"static"` — operator pre-registers an OAuth app in the vendor's
   *   developer portal, gets a `client_id` + `client_secret`, and
   *   provides `operatorSetup` so the Connections-page modal can guide
   *   them. HubSpot, Asana, Gmail, Outlook, Zoom Marketplace.
   */
  auth: "dcr" | "static";
  /**
   * Recommended OAuth identity scope. Workspace admins can override per
   * workspace (the Connectors page exposes a toggle for that). Catalog
   * authors should pick the natural shape: per-user services
   * (Granola, personal Gmail) → `user`; team / org services (org
   * Notion, team Slack, organizational HubSpot) → `workspace`.
   */
  defaultScope: "workspace" | "user";
  /** Optional OAuth scopes the bundle requests. */
  requiredScopes?: string[];
  /** Optional extra authorize-URL params (e.g. Google's access_type=offline). */
  additionalAuthorizationParams?: Record<string, string>;
  /**
   * Required for `auth: "static"`. Tells the Connectors-page admin
   * modal where to send the operator to create the app, what to paste,
   * and which key to seed in the workspace credential store. The
   * matching public `client_id` lives in `workspace.json` under
   * `oauthOperatorApps[<catalogId>].clientId` — set by the operator
   * when they configure the OAuth app for this workspace.
   */
  operatorSetup?: {
    /** Vendor's developer portal URL where the app gets created. */
    portalUrl: string;
    /** One-paragraph instructions ("Create OAuth user app, add scopes ..."). */
    hint: string;
    /** Workspace credential store key for the OAuth client_secret. */
    clientSecretKey: string;
  };
  /** Optional tags for filter / search in the page. */
  tags?: string[];
  /**
   * Marks the connector as exposing a UI surface (in addition to or
   * instead of plain tools). Renders an "Interactive" badge on the
   * connector card and — when installed — auto-mounts the bundle's
   * UI placements as a sidebar entry. Most catalog entries are remote
   * OAuth services with no UI; leave this unset for those.
   */
  interactive?: boolean;
  /**
   * Optional documentation URL — surfaced on the Configure detail
   * page as a "Docs" link next to the action bar. Use this for
   * connector-specific guides (e.g., how to scope HubSpot OAuth, what
   * Granola tools do). When unset, the link is hidden.
   */
  docsUrl?: string;
}

/**
 * Reads the bundled `catalog.yaml` next to this source file and
 * returns the raw entries. Validation happens in `load-catalog.ts`,
 * which is the single entry point callers should use.
 *
 * Kept as an exported function (rather than a top-level `const` array)
 * so module load doesn't do filesystem I/O until something asks for
 * the catalog — keeps test imports cheap and matches the override
 * loader's lazy-read shape.
 */
export function readDefaultCatalogYaml(): unknown[] {
  const path = join(import.meta.dir, "catalog.yaml");
  const text = readFileSync(path, "utf-8");
  const parsed = Bun.YAML.parse(text) as { connectors?: unknown };
  if (!parsed || !Array.isArray(parsed.connectors)) {
    throw new Error(`[catalog] ${path}: top-level 'connectors' must be a list`);
  }
  return parsed.connectors;
}
