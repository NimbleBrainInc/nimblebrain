// overviewActions — the ranking behind the overview's cards: alerts by level,
// then setup steps, then the last conversation.

import { describe, expect, test } from "bun:test";
import type { BriefingItem } from "../src/_generated/platform-schemas/home";
import type { InstalledConnector } from "../src/api/client";
import {
  FIRST_QUESTION,
  type OverviewActionsInput,
  overviewActions,
} from "../src/components/overview/actions";

const SLUG = "acme";
const NO_SETUP = { connectPlugin: false, firstQuestion: false, invite: false };

function input(over: Partial<OverviewActionsInput> = {}): OverviewActionsInput {
  return {
    slug: SLUG,
    briefing: { items: [], generated_at: "" },
    connectors: [],
    reviewCount: 0,
    setup: NO_SETUP,
    lastConversation: null,
    ...over,
  };
}

function item(over: Partial<BriefingItem>): BriefingItem {
  return {
    app: "CRM",
    facet: "overdue",
    label: "Follow-ups overdue",
    count: 2,
    level: "warning",
    route: "@acme/crm",
    state: "ok",
    ...over,
  };
}

function connector(serverName: string, status: InstalledConnector["status"]): InstalledConnector {
  return {
    serverName,
    connectorName: serverName,
    displayName: serverName,
    disconnectable: false,
    version: "1.0.0",
    state: "running",
    scope: "workspace",
    interactive: false,
    toolCount: 1,
    allowedTools: [],
    status,
  };
}

const keys = (i: OverviewActionsInput) => overviewActions(i).map((a) => a.key);

describe("overviewActions", () => {
  test("nothing waiting and nothing to set up gives no actions", () => {
    expect(overviewActions(input())).toEqual([]);
  });

  test("orders alerts by level, then setup, then the last conversation", () => {
    expect(
      keys(
        input({
          briefing: {
            generated_at: "",
            items: [
              item({ facet: "fyi", level: "info" }),
              item({ facet: "late", level: "warning" }),
              item({ facet: "down", level: "critical" }),
            ],
          },
          connectors: [connector("gmail", "needs_auth"), connector("crm", "starting")],
          reviewCount: 2,
          setup: { connectPlugin: false, firstQuestion: true, invite: true },
          lastConversation: { id: "c1", title: "Q3", preview: "", updatedAt: "" },
        }),
      ),
    ).toEqual([
      "connector:gmail",
      "facet:CRM/down",
      "review:runs",
      "facet:CRM/late",
      "connector:crm",
      "facet:CRM/fyi",
      "setup:ask",
      "setup:invite",
      "resume:c1",
    ]);
  });

  test("a connector at rest (never connected, or disconnected) is no alert", () => {
    expect(
      keys(input({ connectors: [connector("a", "ready"), connector("b", "not_connected")] })),
    ).toEqual([]);
  });

  test("a connector that needs someone is critical and opens its page", () => {
    const [a] = overviewActions(input({ connectors: [connector("gmail", "needs_auth")] }));
    expect(a).toMatchObject({
      level: "critical",
      title: "gmail",
      detail: "Reconnection needed",
      verb: "Fix",
      target: { type: "navigate", to: `/w/${SLUG}/settings/connectors/gmail` },
    });
  });

  test("a connector still coming up is info, muted", () => {
    const [a] = overviewActions(input({ connectors: [connector("crm", "connecting")] }));
    expect(a).toMatchObject({ level: "info", muted: true, verb: "Open" });
  });

  test("a facet shows its count and opens its app; an absolute route passes through", () => {
    const [a, b] = overviewActions(
      input({
        briefing: {
          generated_at: "",
          items: [item({}), item({ facet: "x", route: "/w/acme/files" })],
        },
      }),
    );
    expect(a).toMatchObject({
      count: 2,
      title: "Follow-ups overdue",
      detail: "CRM",
      target: { type: "navigate", to: `/w/${SLUG}/app/@acme/crm` },
    });
    expect(b?.target).toEqual({ type: "navigate", to: "/w/acme/files" });
  });

  test("an unavailable facet is muted, has no count, and keeps its action", () => {
    const [a] = overviewActions(
      input({ briefing: { generated_at: "", items: [item({ state: "unavailable", count: 0 })] } }),
    );
    expect(a).toMatchObject({ count: null, muted: true, signature: "unavailable" });
    expect(a?.target.type).toBe("navigate");
  });

  test("a facet with no route has no action", () => {
    const [a] = overviewActions(
      input({ briefing: { generated_at: "", items: [item({ route: null })] } }),
    );
    expect(a?.target).toEqual({ type: "none" });
  });

  test("a level the web does not know reads as warning, including an inherited key", () => {
    const levels = overviewActions(
      input({
        briefing: {
          generated_at: "",
          items: [
            item({ facet: "a", level: "urgent" as BriefingItem["level"] }),
            item({ facet: "b", level: "toString" as BriefingItem["level"] }),
          ],
        },
      }),
    ).map((a) => a.level);
    expect(levels).toEqual(["warning", "warning"]);
  });

  test("results to review open Scheduled with their count", () => {
    const [a] = overviewActions(input({ reviewCount: 3 }));
    expect(a).toMatchObject({
      level: "warning",
      count: 3,
      title: "Results to review",
      target: { type: "navigate", to: `/w/${SLUG}/tasks` },
    });
    expect(overviewActions(input({ reviewCount: 1 }))[0]?.title).toBe("Result to review");
  });

  test("each setup step appears only when asked for, and none can be hidden", () => {
    const steps = overviewActions(
      input({ setup: { connectPlugin: true, firstQuestion: true, invite: true } }),
    );
    expect(steps.map((s) => [s.key, s.target])).toEqual([
      ["setup:plugin", { type: "navigate", to: `/w/${SLUG}/plugins/browse` }],
      ["setup:ask", { type: "ask", prompt: FIRST_QUESTION }],
      ["setup:invite", { type: "navigate", to: `/w/${SLUG}/settings/members?add` }],
    ]);
    expect(steps.every((s) => s.signature === null && s.level === "none")).toBe(true);
  });

  test("the last conversation reopens by id, titled by its title, else its preview", () => {
    const [a] = overviewActions(
      input({ lastConversation: { id: "c9", title: null, preview: "draft", updatedAt: "" } }),
    );
    expect(a).toMatchObject({
      detail: "draft",
      verb: "Continue",
      target: { type: "conversation", id: "c9" },
    });
  });
});
