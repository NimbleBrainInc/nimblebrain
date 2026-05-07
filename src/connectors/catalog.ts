/**
 * Catalog of remote MCP connectors NimbleBrain knows about. Surfaces
 * to the Settings → Connectors page so users can install + connect
 * services with one click rather than editing `workspace.json` directly.
 *
 * Distribution model:
 *
 *   1. `DEFAULT_CONNECTOR_CATALOG` (this file) ships with the platform —
 *      curated by NimbleBrain, vetted entries, sensible scope hints.
 *   2. `NB_CATALOG_PATH` env var (optional) points at a JSON file
 *      (typically a Kubernetes ConfigMap) that **fully replaces** the
 *      default. Operators with custom needs ship their own catalog
 *      without an app release. Replace, not merge — see `load-catalog.ts`
 *      for the rationale.
 *   3. Per-workspace `connectorsAllowList` filter narrows the visible
 *      set (admin reads `workspace.json` to control which services a
 *      tenant sees on their Connectors page).
 *
 * Secrets stay OUT of the catalog. `auth: "static"` entries reference
 * the credential store via `operatorSetup.credentialKey` — the value
 * is set by `nb credential set <wsId> <key> <value>` and never lives in
 * the catalog ConfigMap.
 *
 * Icons hosted at `https://static.nimblebrain.ai/icons/<id>.svg` —
 * existing repo. Self-host deployments behind firewalls can override
 * via the catalog's `iconUrl` field (any absolute URL works).
 */

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
   * modal where to send the operator to create the app, what to
   * paste, and which credential key to seed.
   */
  operatorSetup?: {
    /** Vendor's developer portal URL where the app gets created. */
    portalUrl: string;
    /** One-paragraph instructions ("Create OAuth user app, add scopes ..."). */
    hint: string;
    /** Argument to `nb credential set <wsId> <key> <value>`. */
    credentialKey: string;
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
}

/**
 * Default catalog shipped with the platform. Edit this list to add /
 * remove / update entries. Operators who want a smaller or larger set
 * mount their own catalog via `NB_CATALOG_PATH` (full replacement; see
 * `load-catalog.ts`).
 *
 * Convention: keep ordering alphabetical by id within scope groupings
 * (workspace-shared first, user-scoped second) so diffs read clean.
 */
export const DEFAULT_CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
  // ── Workspace-scoped (shared organizational identity) ──────────
  {
    id: "asana",
    name: "Asana",
    description: "Tasks, projects, and team workflows",
    iconUrl: "https://static.nimblebrain.ai/icons/asana.svg",
    url: "https://mcp.asana.com/v2/mcp",
    auth: "static",
    defaultScope: "workspace",
    operatorSetup: {
      portalUrl: "https://app.asana.com/0/my-apps",
      hint: "Create an OAuth app in Asana developer portal, copy client_id + client_secret",
      credentialKey: "asana.client_secret",
    },
    tags: ["tasks", "projects"],
  },
  {
    id: "notion-org",
    name: "Notion (org)",
    description: "Read & write workspace pages — shared workspace identity",
    iconUrl: "https://static.nimblebrain.ai/icons/notion.svg",
    url: "https://mcp.notion.com/mcp",
    auth: "dcr",
    defaultScope: "workspace",
    tags: ["docs", "knowledge"],
  },

  // ── Member-scoped (personal account per user) ─────────────────
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, send, label your email",
    iconUrl: "https://static.nimblebrain.ai/icons/gmail.svg",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    auth: "static",
    defaultScope: "user",
    requiredScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    additionalAuthorizationParams: {
      access_type: "offline",
      prompt: "consent",
    },
    operatorSetup: {
      portalUrl: "https://console.cloud.google.com/apis/credentials",
      hint: "Create an OAuth 2.0 Client ID (web application) in Google Cloud Console; add the NimbleBrain callback URL as an authorized redirect URI",
      credentialKey: "google.client_secret",
    },
    tags: ["email", "google"],
  },
  {
    id: "granola",
    name: "Granola",
    description: "Personal meeting notes and transcripts",
    iconUrl: "https://static.nimblebrain.ai/icons/granola.svg",
    url: "https://mcp.granola.ai/mcp",
    auth: "dcr",
    defaultScope: "user",
    tags: ["meetings", "notes"],
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "CRM contacts, deals, and pipeline",
    iconUrl: "https://static.nimblebrain.ai/icons/hubspot.svg",
    url: "https://mcp.hubspot.com",
    auth: "static",
    defaultScope: "user",
    operatorSetup: {
      portalUrl:
        "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
      hint: "Create an MCP Auth App in HubSpot Developer Portal; copy client_id + client_secret",
      credentialKey: "hubspot.client_secret",
    },
    tags: ["crm", "sales"],
  },
  {
    id: "outlook",
    name: "Outlook",
    description: "Microsoft 365 mail",
    iconUrl: "https://static.nimblebrain.ai/icons/outlook.svg",
    url: "https://mcp.microsoft.com/mail",
    auth: "static",
    defaultScope: "user",
    requiredScopes: [
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
      "offline_access",
    ],
    operatorSetup: {
      portalUrl:
        "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      hint: "Register a multi-tenant app in Entra ID; add Microsoft Graph delegated permissions; copy client_id + client_secret",
      credentialKey: "entra.client_secret",
    },
    tags: ["email", "microsoft"],
  },
  {
    id: "zoom",
    name: "Zoom",
    description: "Meetings, recordings, contacts",
    iconUrl: "https://static.nimblebrain.ai/icons/zoom.svg",
    url: "https://mcp.zoom.us/mcp",
    auth: "static",
    defaultScope: "user",
    requiredScopes: ["meeting:read", "recording:read"],
    operatorSetup: {
      portalUrl: "https://marketplace.zoom.us/develop/create",
      hint: "Create an OAuth User-Managed app in Zoom Marketplace; add scopes; copy client_id + client_secret",
      credentialKey: "zoom.client_secret",
    },
    tags: ["meetings", "video"],
  },
];
