/**
 * What the Plugins page demo (`bun run dev:plugins-demo`) holds: two
 * workspaces, the plugins installed in each and the state each is in, the dev
 * user's personal plugins and where they are granted, the skills at every
 * scope, and one conversation whose tool calls carry plugin labels.
 *
 * Pure data. `mock-servers.ts` serves the plugins that connect, and `seed.ts`
 * writes the rest through the runtime's stores. Every name here is fictional.
 */

import type { SkillLoadingStrategy } from "../../../src/skills/schemas/skill-manifest.ts";

/** The dev identity every request runs as (`DEV_IDENTITY` in `src/identity/providers/dev.ts`). */
export const DEMO_USER_ID = "usr_default";

/** The account the workspace plugins sign in as, and the one the personal ones do. */
export const WORKSPACE_ACCOUNT = "support@acme.example";
export const PERSONAL_ACCOUNT = "dev@example.com";

// ── Mock servers (the plugins that connect) ────────────────────────────

export interface MockTool {
  name: string;
  description: string;
}

/** A `ui://` view the server places in the sidebar's Apps group. */
export interface MockApp {
  label: string;
  route: string;
}

/** A skill the server publishes under the MCP Skills Extension, bound to some of its tools. */
export interface MockSkill {
  name: string;
  description: string;
  /** Bare tool names of this server the skill is bound to. */
  tools: string[];
  body: string;
}

export interface MockServer {
  /** The connector's server name: its tool namespace. */
  serverName: string;
  title: string;
  description: string;
  tools: MockTool[];
  app?: MockApp;
  skills?: MockSkill[];
}

const t = (name: string, description: string): MockTool => ({ name, description });

/** Every mock server, keyed by server name. A workspace installs some of them by URL. */
export const MOCK_SERVERS: readonly MockServer[] = [
  {
    serverName: "acme-crm",
    title: "Acme CRM",
    description: "Accounts, contacts, and deals in the Acme CRM",
    tools: [
      t("find_account", "Find an account by name or domain"),
      t("list_contacts", "List the contacts on an account"),
      t("log_activity", "Log a call, email, or meeting on an account"),
      t("update_deal", "Change a deal's stage or amount"),
    ],
    app: { label: "Accounts", route: "accounts" },
    skills: [
      {
        name: "account-research",
        description: "How to research an account before replying to its contacts",
        tools: ["find_account", "list_contacts"],
        body: "# Account research\n\nLook the account up first, then read its open deals before you reply.",
      },
    ],
  },
  {
    serverName: "helpdesk",
    title: "Helpdesk",
    description: "The support ticket queue",
    tools: [
      t("list_tickets", "List open tickets, newest first"),
      t("get_ticket", "Read one ticket with its thread"),
      t("reply_to_ticket", "Post a public reply on a ticket"),
      t("assign_ticket", "Assign a ticket to an agent or group"),
      t("close_ticket", "Close a solved ticket"),
      t("add_internal_note", "Add a note only agents can see"),
    ],
    app: { label: "Ticket Queue", route: "tickets" },
    skills: [
      {
        name: "triage-playbook",
        description: "How to sort the queue: priority, product area, and who takes it",
        tools: ["list_tickets", "assign_ticket"],
        body: "# Triage playbook\n\nUrgent first, then oldest. Billing goes to the billing group.",
      },
      {
        name: "reply-tone",
        description: "The voice support replies are written in",
        tools: ["reply_to_ticket"],
        body: "# Reply tone\n\nWarm, short, and specific. Name the next step and when it happens.",
      },
    ],
  },
  {
    serverName: "status-board",
    title: "Status Board",
    description: "Public status page and incident updates",
    tools: [
      t("get_status", "Read the current status of every component"),
      t("post_incident_update", "Post an update to an open incident"),
    ],
    app: { label: "Status", route: "status" },
  },
  {
    serverName: "knowledge-base",
    title: "Knowledge Base",
    description: "Help center articles",
    tools: [
      t("search_articles", "Search help center articles"),
      t("get_article", "Read one article"),
      t("draft_article", "Draft a new article for review"),
    ],
    skills: [
      {
        name: "kb-style",
        description: "House style for help center articles",
        tools: ["draft_article"],
        body: "# Knowledge base style\n\nOne task per article. Steps are numbered and start with a verb.",
      },
    ],
  },
  {
    serverName: "billing-desk",
    title: "Billing Desk",
    description: "Invoices, refunds, and subscriptions",
    tools: [
      t("lookup_invoice", "Find an invoice by number or customer"),
      t("issue_refund", "Refund all or part of a payment"),
      t("list_subscriptions", "List a customer's subscriptions"),
    ],
    skills: [
      {
        name: "refund-policy",
        description: "When a refund is allowed and how much",
        tools: ["issue_refund"],
        body: "# Refund policy\n\nFull refund within 30 days. After that, prorate to the day.",
      },
    ],
  },
  {
    serverName: "release-notes",
    title: "Release Notes",
    description: "What shipped, and when",
    tools: [
      t("list_releases", "List recent releases"),
      t("draft_release_note", "Draft a customer-facing release note"),
    ],
    app: { label: "Releases", route: "releases" },
  },
  {
    serverName: "feature-flags",
    title: "Feature Flags",
    description: "Flags and the customers they are on for",
    tools: [t("list_flags", "List feature flags"), t("toggle_flag", "Turn a flag on or off")],
  },
  {
    serverName: "on-call",
    title: "On-call Rotation",
    description: "Who is on call, and paging them",
    tools: [
      t("who_is_on_call", "Who is on call now for a team"),
      t("page_responder", "Page the on-call responder"),
    ],
  },
  {
    serverName: "survey-hub",
    title: "Survey Hub",
    description: "CSAT and NPS surveys",
    tools: [
      t("list_surveys", "List surveys"),
      t("get_responses", "Read a survey's responses"),
      t("csat_summary", "Summarize CSAT for a period"),
    ],
    app: { label: "CSAT", route: "csat" },
    skills: [
      {
        name: "csat-reporting",
        description: "How the weekly CSAT report is put together",
        tools: ["csat_summary"],
        body: "# CSAT reporting\n\nReport the score, the response count, and three verbatim comments.",
      },
    ],
  },
  {
    serverName: "order-lookup",
    title: "Order Lookup",
    description: "Orders and shipments",
    tools: [
      t("find_order", "Find an order by number or email"),
      t("track_shipment", "Track a shipment"),
    ],
  },
  {
    serverName: "qa-scorecards",
    title: "QA Scorecards",
    description: "Review support conversations against the rubric",
    tools: [
      t("score_conversation", "Score one conversation"),
      t("list_scorecards", "List the rubrics"),
    ],
    skills: [
      {
        name: "qa-rubric",
        description: "The support QA rubric and how to apply it",
        tools: ["score_conversation"],
        body: "# QA rubric\n\nAccuracy, tone, and resolution, each out of five.",
      },
    ],
  },
  {
    serverName: "macros",
    title: "Macro Library",
    description: "Saved replies for common questions",
    tools: [
      "list_macros",
      "get_macro",
      "apply_macro",
      "create_macro",
      "update_macro",
      "archive_macro",
      "list_macro_folders",
      "move_macro",
      "duplicate_macro",
      "search_macros",
      "macro_usage",
      "suggest_macro",
    ].map((name) => t(name, name.replace(/_/g, " "))),
  },
];

// ── Workspace plugins ──────────────────────────────────────────────────

/**
 * A workspace plugin and the state the seed leaves it in:
 *
 * - `ready` — a mock server added by URL that connects at boot.
 * - `failed` — a server added by URL that does not start (`closed`: nothing
 *   listens; `error`: it answers HTTP 503; `wrong-path`: it answers 404).
 * - `needs-sign-in` — a catalog entry installed with no tokens.
 * - `sign-in-expired` — a catalog entry whose credential the runtime recorded
 *   as rejected (the `auth_lost` flag), so it boots `reauth_required`.
 * - `needs-setup` — a static-auth catalog entry whose OAuth client secret is
 *   not in the credential store.
 */
export type WorkspacePlugin =
  | {
      state: "ready";
      serverName: string;
      /** The account its sign-in recorded, or an API key (no identity). */
      account: { email?: string; name?: string } | "api-key";
    }
  | {
      state: "failed";
      serverName: string;
      title: string;
      failure: "closed" | "error" | "wrong-path";
    }
  | { state: "needs-sign-in" | "sign-in-expired" | "needs-setup"; catalogId: string };

export interface DemoWorkspace {
  name: string;
  about: string;
  plugins: WorkspacePlugin[];
  skills: SkillFixture[];
}

const ready = (serverName: string, account: { email?: string; name?: string } | "api-key") =>
  ({ state: "ready", serverName, account }) as const;
const asWorkspace = { email: WORKSPACE_ACCOUNT };

// ── Skills ─────────────────────────────────────────────────────────────

export interface SkillFixture {
  name: string;
  description: string;
  loading: SkillLoadingStrategy;
  triggers?: string[];
  /** Tool-name globs (`<server>__<tool>`); a dynamic skill with these is tool-bound. */
  toolAffinity?: string[];
  disabled?: boolean;
  priority?: number;
}

const skill = (
  name: string,
  description: string,
  opts: Partial<Omit<SkillFixture, "name" | "description">> = {},
): SkillFixture => ({ name, description, loading: opts.loading ?? "dynamic", ...opts });

export const ORG_SKILLS: readonly SkillFixture[] = [
  skill("acme-voice", "How Acme writes to customers: plain words, no jargon", {
    loading: "always",
  }),
  skill("escalation-policy", "When and how to escalate to engineering or leadership", {
    triggers: ["escalate", "escalation"],
  }),
  skill("security-basics", "Handling customer data and suspicious requests"),
  skill("legal-holds", "What to do when a legal hold applies to an account", { disabled: true }),
];

const SUPPORT_SKILLS: SkillFixture[] = [
  skill("support-tone", "Tone and sign-off for every support reply", { loading: "always" }),
  skill("refund-requests", "Handling refund and chargeback requests", {
    triggers: ["refund", "chargeback"],
  }),
  skill("ticket-replies", "Checklist before a public reply goes out", {
    toolAffinity: ["helpdesk__reply_to_ticket"],
  }),
  skill("incident-comms", "Writing incident updates customers can follow", {
    toolAffinity: ["status-board__post_incident_update"],
  }),
  skill("vip-accounts", "Extra care for accounts on the enterprise plan", {
    toolAffinity: ["acme-crm__*"],
  }),
  skill("shipping-delays", "What to tell a customer whose order is late", {
    triggers: ["late order", "where is my order"],
  }),
  skill("bug-reports", "Turning a customer report into a bug ticket engineering can act on"),
  skill("weekly-digest", "Writing the Friday support digest", { triggers: ["weekly digest"] }),
  skill("macro-hygiene", "Keeping the macro library current", {
    toolAffinity: ["macros__create_macro", "macros__update_macro"],
  }),
  skill("handover-notes", "End-of-shift handover notes"),
  skill("holiday-coverage", "Holiday staffing and auto-replies", { disabled: true }),
  skill("beta-feedback", "Collecting feedback from beta customers", { disabled: true }),
];

const SALES_SKILLS: SkillFixture[] = [
  skill("discovery-calls", "Questions for a first discovery call", {
    triggers: ["discovery call"],
  }),
  skill("deal-updates", "Keeping deal stages honest", { toolAffinity: ["acme-crm__update_deal"] }),
  skill("pricing-guardrails", "Discount limits by plan", { loading: "always" }),
];

/** The dev user's own skills: a long list, mostly on request, so the list is judged at scale. */
export const USER_SKILLS: readonly SkillFixture[] = [
  skill("my-signature", "My email sign-off", { loading: "always" }),
  skill("plain-summaries", "Summaries in five bullets or fewer", { loading: "always" }),
  skill("meeting-notes", "Turning a call into notes and next steps", {
    triggers: ["meeting notes"],
  }),
  skill("standup-update", "My daily standup format", { triggers: ["standup"] }),
  skill("calendar-etiquette", "Proposing meeting times across time zones", {
    toolAffinity: ["my_com-google-calendar-mcp__*"],
  }),
  skill("todo-capture", "Capturing tasks as I mention them", {
    toolAffinity: ["my_com-todoist-mcp__*"],
  }),
  skill("customer-recap", "Recap of a customer's history before a call"),
  skill("bug-triage-notes", "How I write up a bug I reproduced"),
  skill("sql-helpers", "Common queries against the support warehouse"),
  skill("spreadsheet-cleanup", "Cleaning up an exported spreadsheet"),
  skill("translation-check", "Checking a translated reply before sending", {
    triggers: ["translate"],
  }),
  skill("release-readout", "Reading release notes for what affects customers"),
  skill("escalation-draft", "Drafting an escalation to engineering", {
    triggers: ["draft escalation"],
  }),
  skill("onboarding-checklist", "First-week checklist for a new customer"),
  skill("renewal-prep", "Preparing for a renewal conversation"),
  skill("churn-signals", "Signs an account is at risk"),
  skill("feature-request-log", "Logging a feature request with context"),
  skill("apology-notes", "Writing a sincere apology"),
  skill("refund-math", "Prorating a refund by day"),
  skill("tone-softener", "Softening a blunt draft", { triggers: ["soften this"] }),
  skill("headline-writer", "Writing a clear subject line"),
  skill("faq-builder", "Turning repeated questions into an FAQ"),
  skill("survey-questions", "Writing survey questions that are not leading"),
  skill("call-prep", "Five minutes of prep before any call"),
  skill("weekly-review", "My Friday review of the week", { triggers: ["weekly review"] }),
  skill("inbox-zero", "Clearing my inbox in one pass"),
  skill("doc-outline", "Outlining a long document"),
  skill("slide-notes", "Speaker notes for a short deck"),
  skill("data-requests", "Answering a customer's data export request"),
  skill("privacy-requests", "Handling a deletion or access request"),
  skill("sla-math", "Working out SLA breaches by hour"),
  skill("handoff-to-sales", "Passing an upsell lead to sales"),
  skill("product-glossary", "Product terms and what they mean"),
  skill("keyboard-shortcuts", "Shortcuts I keep forgetting"),
  skill("travel-planning", "Planning a work trip"),
  skill("reading-list", "Articles to read later"),
  skill("old-macros", "Macros from the previous helpdesk", { disabled: true }),
  skill("draft-experiments", "Prompts I am trying out", { disabled: true }),
];

/** The dev workspace and a second one, each with its plugins and skills. */
export const DEMO_WORKSPACES: readonly DemoWorkspace[] = [
  {
    name: "Acme Support",
    about: "Customer support at Acme",
    plugins: [
      ready("acme-crm", asWorkspace),
      ready("helpdesk", asWorkspace),
      ready("status-board", { name: "Acme Status" }),
      ready("knowledge-base", { name: "Acme Support Team" }),
      ready("billing-desk", "api-key"),
      ready("release-notes", asWorkspace),
      ready("feature-flags", "api-key"),
      ready("on-call", asWorkspace),
      ready("survey-hub", asWorkspace),
      ready("order-lookup", asWorkspace),
      ready("qa-scorecards", asWorkspace),
      ready("macros", asWorkspace),
      { state: "failed", serverName: "legacy-sync", title: "Legacy Sync", failure: "closed" },
      { state: "failed", serverName: "sla-monitor", title: "SLA Monitor", failure: "error" },
      {
        state: "failed",
        serverName: "translation-bridge",
        title: "Translation Bridge",
        failure: "wrong-path",
      },
      ...[
        "com.notion/mcp",
        "app.linear/mcp",
        "com.slack/mcp",
        "com.github/mcp",
        "com.atlassian.jira/mcp",
        "com.asana/mcp",
        "com.hubspot/mcp",
        "com.zendesk/mcp",
        "com.intercom/mcp",
        "com.airtable/mcp",
      ].map((catalogId) => ({ state: "needs-sign-in", catalogId }) as const),
      ...[
        "com.google.drive/mcp",
        "com.calendly/mcp",
        "com.dropbox/mcp",
        "us.zoom/mcp",
        "com.shopify/mcp",
      ].map((catalogId) => ({ state: "sign-in-expired", catalogId }) as const),
      ...[
        "com.salesforce/mcp",
        "com.google.gmail/mcp",
        "com.microsoft.outlook/mcp",
        "com.intuit.quickbooks/mcp",
        "com.stripe/mcp",
      ].map((catalogId) => ({ state: "needs-setup", catalogId }) as const),
    ],
    skills: SUPPORT_SKILLS,
  },
  {
    name: "Acme Sales",
    about: "The Acme sales team",
    plugins: [
      ready("acme-crm", { email: "sales@acme.example" }),
      ready("order-lookup", "api-key"),
      { state: "needs-sign-in", catalogId: "app.linear/mcp" },
      { state: "needs-sign-in", catalogId: "com.slack/mcp" },
      { state: "sign-in-expired", catalogId: "com.hubspot/mcp" },
      { state: "needs-setup", catalogId: "com.salesforce/mcp" },
    ],
    skills: SALES_SKILLS,
  },
];

// ── Personal plugins ───────────────────────────────────────────────────

/**
 * One of the dev user's personal plugins: a catalog entry on their identity,
 * signed in or not, and the workspaces (by name) they granted it to.
 */
export interface PersonalPlugin {
  catalogId: string;
  connected: boolean;
  /** The account its sign-in recorded; defaults to {@link PERSONAL_ACCOUNT}. */
  account?: { email?: string; name?: string };
  grantedIn: string[];
}

const SUPPORT = "Acme Support";
const SALES = "Acme Sales";

export const PERSONAL_PLUGINS: readonly PersonalPlugin[] = [
  // Granted here and signed in.
  { catalogId: "com.google.calendar/mcp", connected: true, grantedIn: [SUPPORT, SALES] },
  { catalogId: "com.todoist/mcp", connected: true, grantedIn: [SUPPORT] },
  { catalogId: "com.notion/mcp", connected: true, grantedIn: [SUPPORT] },
  { catalogId: "com.canva/mcp", connected: true, account: { name: "Dev" }, grantedIn: [SUPPORT] },
  // Granted here, not signed in.
  { catalogId: "com.monday/mcp", connected: false, grantedIn: [SUPPORT] },
  { catalogId: "com.clickup/mcp", connected: false, grantedIn: [SUPPORT] },
  { catalogId: "com.miro/mcp", connected: false, grantedIn: [SUPPORT, SALES] },
  // Not granted here, signed in.
  { catalogId: "io.sentry/mcp", connected: true, grantedIn: [] },
  { catalogId: "com.figma/mcp", connected: true, grantedIn: [] },
  { catalogId: "com.box/mcp", connected: true, grantedIn: [] },
  // Not granted here, not signed in.
  { catalogId: "com.trello/mcp", connected: false, grantedIn: [] },
  { catalogId: "com.docusign/mcp", connected: false, grantedIn: [] },
  { catalogId: "io.gong/mcp", connected: false, grantedIn: [] },
  // Granted only in the second workspace.
  { catalogId: "com.xero/mcp", connected: true, grantedIn: [SALES] },
  { catalogId: "com.pagerduty/mcp", connected: true, grantedIn: [SALES] },
  { catalogId: "com.datadoghq/mcp", connected: false, grantedIn: [SALES] },
];

/** The id of the seeded conversation whose tool calls carry plugin labels. */
export const DEMO_CONVERSATION_ID = "conv_d3e0000000000001";
