// ---------------------------------------------------------------------------
// The overview's actions: everything the page may offer a member, ranked.
//
// Pure: it takes what the overview has already loaded and returns the actions
// in the order the page shows them. Three groups, in this order:
//   1. Alerts. A connector that is not ready, scheduled task runs waiting for a
//      verdict, and each facet an app's server counted. Ordered by level:
//      `critical` (something has stopped), then `warning` (someone should act),
//      then `info` (worth knowing). Within a level, connectors lead, then runs to
//      review, then facets in the server's order.
//   2. Setup. The next step for a workspace that has not taken it: connect a
//      plugin, ask a first question, invite someone. Each appears only while it
//      is undone and the member can take it.
//   3. Resume. The workspace's most recent conversation.
// The page shows the first few and folds the rest behind "Show more", so the
// order is the whole ranking: the most urgent thing is always first.
//
// Alerts can be hidden until they change (`briefing-prefs.ts`); setup and
// resume cannot, since each goes away by itself once taken.
// ---------------------------------------------------------------------------

import type {
  BriefingItem,
  BriefingLevel,
  BriefingOutput,
} from "../../_generated/platform-schemas/home";
import type { InstalledConnector } from "../../api/client";
import type { RecentConversation } from "../../hooks/useRecentConversations";
import { connectorSettingsPath } from "../../lib/workspace-apps";
import { statusLabel } from "../connectors/ConnectorHeader";

/** An alert's level, or `none` for setup and resume. */
export type ActionLevel = BriefingLevel | "none";

/** What choosing an action does. */
export type ActionTarget =
  | { type: "navigate"; to: string }
  /** Reopen a conversation in the chat. */
  | { type: "conversation"; id: string }
  /** Send a question to the agent. */
  | { type: "ask"; prompt: string }
  | { type: "none" };

/** What an action is about; the row's icon follows it. */
export type ActionKind = "connector" | "review" | "facet" | "plugin" | "ask" | "invite" | "resume";

export interface OverviewAction {
  key: string;
  kind: ActionKind;
  /**
   * What an alert says now; a hidden alert returns when this changes. `null`
   * for an action that cannot be hidden.
   */
  signature: string | null;
  level: ActionLevel;
  /** A count shown large, or null. */
  count: number | null;
  title: string;
  detail: string;
  /** Rendered muted: a facet that could not be read, a connector still coming up. */
  muted: boolean;
  target: ActionTarget;
  testId: string;
}

export interface OverviewActionsInput {
  /** The workspace's URL slug. */
  slug: string;
  briefing: BriefingOutput | null;
  /** The workspace's installed connectors. */
  connectors: readonly InstalledConnector[];
  /** Scheduled task runs waiting for a person's verdict. */
  reviewCount: number;
  /** Which setup steps to offer; each is true only while undone and takeable. */
  setup: { connectPlugin: boolean; firstQuestion: boolean; invite: boolean };
  lastConversation: RecentConversation | null;
}

/** The question the "ask what it can do" step sends. */
export const FIRST_QUESTION = "What can you help me do in this workspace?";

const LEVEL_RANK: Record<BriefingLevel, number> = { critical: 0, warning: 1, info: 2 };

/**
 * The host's level for a connector that is not ready. One it cannot work
 * without someone acting on is `critical`; one still coming up resolves on its
 * own and is `info`.
 */
export function statusLevel(status: InstalledConnector["status"]): BriefingLevel {
  return status === "connecting" || status === "starting" ? "info" : "critical";
}

/** A level the web does not know reads as `warning`, as the extension requires. */
function levelOf(level: string): BriefingLevel {
  return Object.hasOwn(LEVEL_RANK, level) ? (level as BriefingLevel) : "warning";
}

function connectorAction(c: InstalledConnector, slug: string): OverviewAction {
  const level = statusLevel(c.status);
  const to = connectorSettingsPath(slug, c.serverName);
  return {
    key: `connector:${c.serverName}`,
    kind: "connector",
    signature: c.status,
    level,
    count: null,
    title: c.displayName,
    detail: statusLabel(c.status),
    muted: level === "info",
    target: to ? { type: "navigate", to } : { type: "none" },
    testId: "overview-action-connector",
  };
}

function facetAction(item: BriefingItem, slug: string): OverviewAction {
  const unavailable = item.state === "unavailable";
  const { route } = item;
  return {
    key: `facet:${item.app}/${item.facet}`,
    kind: "facet",
    signature: unavailable ? "unavailable" : `ok:${item.count}`,
    level: levelOf(item.level),
    count: unavailable ? null : item.count,
    title: item.label,
    detail: unavailable ? `${item.app} · unavailable` : item.app,
    muted: unavailable,
    // An item carries its app's placement route (e.g. "@scope/name"). Absolute
    // paths pass through; bare routes open the app in this workspace.
    target: route
      ? { type: "navigate", to: route.startsWith("/") ? route : `/w/${slug}/app/${route}` }
      : { type: "none" },
    testId: unavailable ? "overview-action-facet-unavailable" : "overview-action-facet",
  };
}

function reviewAction(count: number, slug: string): OverviewAction {
  return {
    key: "review:runs",
    kind: "review",
    signature: `ok:${count}`,
    level: "warning",
    count,
    title: count === 1 ? "Result to review" : "Results to review",
    detail: "Scheduled",
    muted: false,
    target: { type: "navigate", to: `/w/${slug}/tasks` },
    testId: "overview-action-review",
  };
}

function setupActions(input: OverviewActionsInput): OverviewAction[] {
  const { slug, setup } = input;
  const out: OverviewAction[] = [];
  const step = (
    key: "plugin" | "ask" | "invite",
    title: string,
    detail: string,
    target: ActionTarget,
  ): OverviewAction => ({
    key: `setup:${key}`,
    kind: key,
    signature: null,
    level: "none",
    count: null,
    title,
    detail,
    muted: false,
    target,
    testId: `overview-action-setup-${key}`,
  });
  if (setup.connectPlugin) {
    out.push(
      step("plugin", "Connect a plugin", "Give the agent the tools this workspace works with", {
        type: "navigate",
        to: `/w/${slug}/plugins/browse`,
      }),
    );
  }
  if (setup.firstQuestion) {
    out.push(
      step("ask", "Ask what it can do", "See what the agent can do in this workspace", {
        type: "ask",
        prompt: FIRST_QUESTION,
      }),
    );
  }
  if (setup.invite) {
    out.push(
      step("invite", "Invite people", "Only you so far", {
        type: "navigate",
        to: `/w/${slug}/settings/members?add`,
      }),
    );
  }
  return out;
}

/** Every action the overview may show, most urgent first. */
export function overviewActions(input: OverviewActionsInput): OverviewAction[] {
  const { slug } = input;
  // Every status but `ready` and `not_connected`: a connector never connected,
  // or disconnected on purpose, is at rest and asks nothing of anyone. One still
  // `connecting` stays in, because an OAuth abandoned mid-flow stays there and
  // its page is where it is cancelled.
  const alerts: OverviewAction[] = [
    ...input.connectors
      .filter((c) => c.status !== "ready" && c.status !== "not_connected")
      .map((c) => connectorAction(c, slug)),
    ...(input.reviewCount > 0 ? [reviewAction(input.reviewCount, slug)] : []),
    ...(input.briefing?.items ?? []).map((item) => facetAction(item, slug)),
  ];
  // Sort is stable, so within a level the order above holds.
  alerts.sort(
    (a, b) => LEVEL_RANK[a.level as BriefingLevel] - LEVEL_RANK[b.level as BriefingLevel],
  );

  const resume: OverviewAction[] = input.lastConversation
    ? [
        {
          key: `resume:${input.lastConversation.id}`,
          kind: "resume",
          signature: null,
          level: "none",
          count: null,
          title: "Continue",
          detail:
            input.lastConversation.title ||
            input.lastConversation.preview ||
            "Untitled conversation",
          muted: false,
          target: { type: "conversation", id: input.lastConversation.id },
          testId: "overview-action-resume",
        },
      ]
    : [];

  return [...alerts, ...setupActions(input), ...resume];
}
