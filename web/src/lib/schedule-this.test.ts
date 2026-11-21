import { describe, expect, test } from "bun:test";
import { scheduleThisMessage } from "./schedule-this";

describe("scheduleThisMessage", () => {
  test("quotes the request, every line, and asks for when and where", () => {
    const msg = scheduleThisMessage("  Summarize my unread email\nand flag anything urgent  ");
    expect(msg).toBe(
      [
        "Make this a scheduled task:",
        "",
        "> Summarize my unread email",
        "> and flag anything urgent",
        "",
        "Ask me when it should run and where the result should go, then show me what you set up.",
      ].join("\n"),
    );
  });
});
