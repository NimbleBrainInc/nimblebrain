/**
 * Hardcoded curated stdio bundle list — the NimbleBrain-blessed set of
 * `@nimblebraininc/*` mpak bundles surfaced on the Browse page.
 *
 * Why this exists separate from `catalog.ts`:
 *   - `catalog.ts` carries remote-OAuth services (Asana, HubSpot, ...).
 *     Different shape (URL + OAuth scopes) and different install path.
 *   - This file carries stdio bundles installed via the mpak SDK.
 *     They're presented in the same Browse list (as `mpak-bundle`-kind
 *     `DirectoryEntry`s) and end up calling `lifecycle.installNamed`,
 *     which uses mpak's bundle cache + registry under the hood.
 *
 * The list is intentionally hand-curated rather than auto-discovered —
 * we want explicit control over what shows up in the UI (private
 * bundles excluded; deprecated entries can be cut without surprise).
 *
 * Add a new bundle by:
 *   1. Releasing it to mpak with the published name `@nimblebraininc/<id>`.
 *   2. Appending an entry below.
 *
 * Bundles published privately (e.g. tenant-specific Synapse apps) stay
 * out of this list — they install via the chat agent's `bundleManagement`
 * tool, not Browse.
 */

export interface StdioBundleEntry {
  /** Stable id used as the catalog id and serverName at install time. */
  id: string;
  /** Display name for the Browse card. */
  name: string;
  /** One-sentence description. Surfaces under the name on the Browse row. */
  description: string;
  /** Scoped mpak package name; passed to `lifecycle.installNamed`. */
  bundleName: string;
  /** Free-form tags. UI may render some as badges. */
  tags?: string[];
  /** When true, installing this bundle adds a sidebar / placement UI. */
  interactive?: boolean;
  /** Optional icon URL for the Browse row. */
  iconUrl?: string;
}

export const STDIO_BUNDLES: StdioBundleEntry[] = [
  {
    id: "abstract",
    name: "Abstract",
    description:
      "Abstract API server with email validation, phone validation, IP geolocation, and more",
    bundleName: "@nimblebraininc/abstract",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "aws-ses",
    name: "AWS SES",
    description: "Send emails using AWS Simple Email Service (SES)",
    bundleName: "@nimblebraininc/aws-ses",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "bash",
    name: "Bash",
    description: "Execute bash commands via MCP",
    bundleName: "@nimblebraininc/bash",
    tags: ["mcp-server"],
    interactive: false,
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search using the Brave Search API",
    bundleName: "@nimblebraininc/brave-search",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "clickhouse",
    name: "ClickHouse",
    description:
      "ClickHouse database connectivity with read-only SQL queries, schema exploration, and chDB support",
    bundleName: "@nimblebraininc/clickhouse",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "deepl",
    name: "DeepL",
    description: "DeepL translation API with comprehensive translation tools",
    bundleName: "@nimblebraininc/deepl",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "echo",
    name: "Echo",
    description: "Echo server for testing and debugging MCP connections",
    bundleName: "@nimblebraininc/echo",
    tags: ["mcp-server"],
    interactive: false,
  },
  {
    id: "finnhub",
    name: "Finnhub",
    description: "Financial market data and news MCP service powered by Finnhub API",
    bundleName: "@nimblebraininc/finnhub",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "folk",
    name: "Folk",
    description: "Folk CRM server for managing people, companies, notes, and reminders",
    bundleName: "@nimblebraininc/folk",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "git-worktree",
    name: "Git Worktree",
    description:
      "Git worktree manager for isolated workspaces with branch lifecycle, risk classification, and merge control",
    bundleName: "@nimblebraininc/git-worktree",
    tags: ["mcp-server"],
    interactive: false,
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "GitHub MCP server for repository management, issues, PRs, and workflow automation",
    bundleName: "@nimblebraininc/github",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "gohighlevel",
    name: "GoHighLevel",
    description: "MCP server for GoHighLevel CRM contact management",
    bundleName: "@nimblebraininc/gohighlevel",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "google-places",
    name: "Google Places",
    description:
      "Google Places API MCP server — search businesses, extract websites, phone numbers, addresses, and Google Maps URLs",
    bundleName: "@nimblebraininc/google-places",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "hunter",
    name: "Hunter",
    description: "MCP server for Hunter.io — email discovery, verification, and enrichment",
    bundleName: "@nimblebraininc/hunter",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "ipinfo",
    name: "IPInfo",
    description: "IP intelligence server with geolocation, ASN, company, and privacy detection",
    bundleName: "@nimblebraininc/ipinfo",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "mcp-massive",
    name: "Massive",
    description:
      "Financial market data, technical indicators, and SEC filings MCP service powered by Massive API",
    bundleName: "@nimblebraininc/mcp-massive",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "mcp-quiver",
    name: "Quiver",
    description: "Political and alternative financial data from Quiver Quantitative",
    bundleName: "@nimblebraininc/mcp-quiver",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "nationalparks",
    name: "National Parks",
    description:
      "MCP server for National Parks Service API — search parks, get details, alerts, campgrounds, events, and visitor centers",
    bundleName: "@nimblebraininc/nationalparks",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "newsapi",
    name: "NewsAPI",
    description: "Search news articles and top headlines using the NewsAPI",
    bundleName: "@nimblebraininc/newsapi",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "openweathermap",
    name: "OpenWeatherMap",
    description: "OpenWeatherMap MCP Server for weather data, forecasts, alerts, and air quality",
    bundleName: "@nimblebraininc/openweathermap",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "pdfco",
    name: "PDF.co",
    description: "PDF.co MCP Server with comprehensive PDF manipulation and OpenAPI support",
    bundleName: "@nimblebraininc/pdfco",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "postgres",
    name: "Postgres",
    description:
      "PostgreSQL MCP server with AI-powered tuning, index optimization, and database health analysis",
    bundleName: "@nimblebraininc/postgres",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "registry-tools",
    name: "Registry Tools",
    description: "Search and resolve MCP server packages from the mpak registry",
    bundleName: "@nimblebraininc/registry-tools",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "synapse-astro-editor",
    name: "Astro Editor",
    description:
      "Natural-language editor for Astro websites. Point the agent at a GitHub repo; chat drives every edit (text, JSX, blog posts, image uploads).",
    bundleName: "@nimblebraininc/synapse-astro-editor",
    tags: ["synapse-app", "needs-config"],
    interactive: true,
  },
  {
    id: "synapse-collateral",
    name: "Collateral Studio",
    description:
      "Typst-powered document generation with brand-aware templates, live preview, and conversational iteration",
    bundleName: "@nimblebraininc/synapse-collateral",
    tags: ["synapse-app"],
    interactive: true,
  },
  {
    id: "synapse-crm",
    name: "CRM",
    description:
      "Lightweight contact and deal tracker with agent-driven follow-ups and pipeline reviews.",
    bundleName: "@nimblebraininc/synapse-crm",
    tags: ["synapse-app"],
    interactive: true,
  },
  {
    id: "synapse-db-query",
    name: "DB Query",
    description: "Natural-language Postgres query app with dynamic Vega-Lite visualizations",
    bundleName: "@nimblebraininc/synapse-db-query",
    tags: ["synapse-app", "needs-config"],
    interactive: true,
  },
  {
    id: "synapse-hello",
    name: "Hello",
    description: "Hello World MCP App for NimbleBrain Platform",
    bundleName: "@nimblebraininc/synapse-hello",
    tags: ["synapse-app"],
    interactive: true,
  },
  {
    id: "synapse-mcp-dev-summit",
    name: "MCP Dev Summit",
    description:
      "Conference companion for MCP Dev Summit NA 2026 — search sessions, build a personal schedule, capture notes, and get AI-powered recommendations",
    bundleName: "@nimblebraininc/synapse-mcp-dev-summit",
    tags: ["synapse-app"],
    interactive: true,
  },
  {
    id: "synapse-research",
    name: "Research",
    description:
      "Research runs powered by MCP tasks. Kick off long-running research and track progress in real time.",
    bundleName: "@nimblebraininc/synapse-research",
    tags: ["synapse-app", "needs-config"],
    interactive: true,
  },
  {
    id: "synapse-signal-graph",
    name: "Signal Graph",
    description:
      "Political-financial intelligence app that cross-references congressional trades, insider transactions, lobbying, and government contracts.",
    bundleName: "@nimblebraininc/synapse-signal-graph",
    tags: ["synapse-app"],
    interactive: true,
  },
  {
    id: "synapse-todo-board",
    name: "Todo Board",
    description:
      "Kanban-style task manager with board and table views, AI-powered triage, and daily reviews",
    bundleName: "@nimblebraininc/synapse-todo-board",
    tags: ["synapse-app"],
    interactive: true,
  },
  {
    id: "text-utils",
    name: "Text Utils",
    description:
      "Text manipulation toolkit with reverse, case conversion, slugify, URL extraction, truncation, and token counting",
    bundleName: "@nimblebraininc/text-utils",
    tags: ["mcp-server"],
    interactive: false,
  },
  {
    id: "webfetch",
    name: "WebFetch",
    description: "Fetch web pages and answer questions about their content using Claude",
    bundleName: "@nimblebraininc/webfetch",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
  {
    id: "workspace-tools",
    name: "Workspace Tools",
    description:
      "Git-backed workspace tools for AI agents: file ops, commits, search, and skill validation",
    bundleName: "@nimblebraininc/workspace-tools",
    tags: ["mcp-server", "needs-config"],
    interactive: false,
  },
];

/** Look up a stdio bundle by id. Returns undefined if no match. */
export function findStdioBundle(id: string): StdioBundleEntry | undefined {
  return STDIO_BUNDLES.find((e) => e.id === id);
}
