import { describe, expect, it } from "bun:test";
import type { StoredMessage } from "../../../src/conversation/types.ts";
import {
  conversationCarry,
  matchCandidates,
  matchConversation,
} from "../../../src/runtime/conversation-carry.ts";

const timestamp = "2026-11-18T00:00:00.000Z";
const user = (text: string): StoredMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});
const called = (...names: string[]): StoredMessage => ({
  role: "assistant",
  timestamp,
  content: names.map((toolName, i) => ({
    type: "tool-call" as const,
    toolCallId: `c${i}`,
    toolName,
    input: "{}",
  })),
});

describe("conversationCarry", () => {
  it("collects user texts in order and each called tool once", () => {
    const carry = conversationCarry([
      user("make a task"),
      called("nb__search", "tasks__create"),
      user("make it 9am"),
      called("tasks__create", "tasks__update"),
    ]);

    expect(carry.userTexts).toEqual(["make a task", "make it 9am"]);
    expect(carry.calledTools).toEqual(["nb__search", "tasks__create", "tasks__update"]);
  });

  it("is empty for a conversation with no history", () => {
    expect(conversationCarry(undefined)).toEqual({ userTexts: [], calledTools: [] });
  });
});

describe("matchCandidates", () => {
  it("reads the turn's own text first, then earlier messages newest first", () => {
    // `recorded` already holds this turn's message as its last entry.
    expect(matchCandidates("run it", ["schedule a digest", "make it 9am", "run it"])).toEqual([
      "run it",
      "make it 9am",
      "schedule a digest",
    ]);
  });

  it("is the turn's text alone on a first turn", () => {
    expect(matchCandidates("hello", ["hello"])).toEqual(["hello"]);
  });
});

describe("matchConversation", () => {
  const match = (text: string) => (text.includes("task") ? "task-skill" : null);

  it("holds an earlier match on a turn that matches nothing", () => {
    expect(matchConversation(match, "make it 9am", ["set up a task", "make it 9am"])).toBe(
      "task-skill",
    );
  });

  it("is null when no message matches", () => {
    expect(matchConversation(match, "hello", ["hi", "hello"])).toBeNull();
  });
});
