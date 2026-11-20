/**
 * Chat shows the task a `tasks__create` call saved as a card: the tool names the
 * card's resource, and the card is the panel's bundle marked to pick that view.
 */
import { describe, expect, test } from "bun:test";
import { TOOL_VIEWS } from "../../../../src/platform/tasks/source.ts";
import {
  cardHtml,
  TASKS_CARD_HTML,
  TASKS_CARD_URI,
  TASKS_PANEL_URI,
} from "../../../../src/platform/tasks/ui-resource.ts";

describe("the saved-task card", () => {
  test("only a save names a view, and it is the card", () => {
    expect(TOOL_VIEWS).toEqual({ create: TASKS_CARD_URI });
    expect(TASKS_CARD_URI).not.toBe(TASKS_PANEL_URI);
  });

  test("the card is the panel's document marked as the card", () => {
    expect(cardHtml("<html><head><title>x</title></head><body></body></html>")).toBe(
      '<html><head><meta name="nb-tasks-view" content="card"><title>x</title></head><body></body></html>',
    );
    expect(cardHtml("<p>no head</p>")).toBe(
      '<meta name="nb-tasks-view" content="card"><p>no head</p>',
    );
    expect(TASKS_CARD_HTML).toContain('<meta name="nb-tasks-view" content="card">');
  });
});
