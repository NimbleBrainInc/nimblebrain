/** The card chat shows under a saved task, and how the bundle picks it. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { viewOf } from "../App.tsx";
import type { TaskDetail } from "../types.ts";
import { SavedCardBody, savedTaskId } from "./SavedCard.tsx";

describe("viewOf", () => {
  test("the card mark picks the card; anything else is the panel", () => {
    expect(viewOf("card")).toBe("card");
    expect(viewOf("panel")).toBe("panel");
    expect(viewOf(null)).toBe("panel");
  });
});

describe("savedTaskId", () => {
  test("reads the saved task's id from a create result", () => {
    expect(savedTaskId({ task: { id: "morning-digest" } })).toBe("morning-digest");
    expect(savedTaskId({})).toBeNull();
    expect(savedTaskId(null)).toBeNull();
  });
});

const TASK: TaskDetail = {
  id: "morning-digest",
  name: "Morning digest",
  prompt: "Summarize my unread email.",
  schedule: { cron: "0 7 * * 1-5", timezone: "UTC" },
  scheduleHuman: "Weekdays at 7:00 AM",
  enabled: true,
  runCount: 0,
  consecutiveErrors: 0,
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const card = (task: TaskDetail | null, extra: Partial<Parameters<typeof SavedCardBody>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SavedCardBody, {
      task,
      note: null,
      error: null,
      busy: false,
      onTry: () => {},
      onToggle: () => {},
      onOpen: () => {},
      ...extra,
    }),
  );

describe("SavedCardBody", () => {
  test("reads the task back: what, when, first run, and the three actions", () => {
    const html = card(TASK);
    expect(html).toContain("Scheduled task saved");
    expect(html).toContain("Morning digest");
    expect(html).toContain("Weekdays at 7:00 AM");
    expect(html).toContain("Summarize my unread email.");
    expect(html).toContain("First run");
    expect(html).toContain("Try it now");
    expect(html).toContain(">Pause<");
    expect(html).toContain("Open in Scheduled");
  });
  test("a paused one says so and offers Turn on", () => {
    const html = card({ ...TASK, enabled: false });
    expect(html).toContain("Paused: it won&#x27;t run until you turn it on");
    expect(html).toContain(">Turn on<");
  });
  test("a manual one runs only when you run it, with no pause", () => {
    const html = card({ ...TASK, schedule: undefined });
    expect(html).toContain("Only when you run it");
    expect(html).not.toContain(">Pause<");
  });
  test("loading, then a read error in words", () => {
    expect(card(null)).toContain('aria-busy="true"');
    expect(card(null, { error: "This task could not be read." })).toContain(
      "This task could not be read.",
    );
  });
});
