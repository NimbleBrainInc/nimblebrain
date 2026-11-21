/** The form's first screen: a name that follows the prompt, and what opens More options. */
import { describe, expect, test } from "bun:test";
import { emptyDraft } from "../lib/editorDraft.ts";
import { hasAdvanced, nameFromPrompt } from "./TaskEditor.tsx";

describe("nameFromPrompt", () => {
  test("the first six words, capitalized, without placeholders or punctuation", () => {
    expect(nameFromPrompt("summarize my unread email: who wrote, and what they ask")).toBe(
      "Summarize my unread email who wrote",
    );
    expect(nameFromPrompt("Check [page or topic] for changes")).toBe("Check for changes");
    expect(nameFromPrompt("   ")).toBe("");
  });
});

describe("hasAdvanced", () => {
  test("a blank draft keeps More options closed", () => {
    expect(hasAdvanced(emptyDraft())).toBe(false);
  });
  test("anything set under More options opens it", () => {
    expect(hasAdvanced({ ...emptyDraft(), doMode: "skill" })).toBe(true);
    expect(hasAdvanced({ ...emptyDraft(), model: "anthropic:claude-sonnet-4-6" })).toBe(true);
    expect(hasAdvanced({ ...emptyDraft(), budgetOn: true })).toBe(true);
  });
});
