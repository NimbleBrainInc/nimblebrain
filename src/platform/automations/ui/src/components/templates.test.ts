/**
 * An automation is a full agent run whose result only its owner can open, so a
 * template must not offer one for what the workspace overview already renders
 * for every member: the summary of what is waiting.
 */

import { expect, test } from "bun:test";
import { TEMPLATES } from "./CreateAutomationForm.tsx";

test("no template produces the workspace summary", () => {
  expect(TEMPLATES.map((t) => t.id)).not.toContain("daily-briefing");
  expect(TEMPLATES.some((t) => /briefing/i.test(`${t.name} ${t.prompt}`))).toBe(false);
});
