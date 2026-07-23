// ---------------------------------------------------------------------------
// InContextPopover — render contract.
//
// The header affordance answers "what's equipping this conversation" from the
// recorded run digest (`compose.assembled_context` — one read powers both
// sections). Pins:
//   1. The Budget section renders the per-source token breakdown + total.
//   2. The Skills section renders each loaded skill with scope + tokens.
//   3. A conversation with no recorded run shows the empty state.
//
// @testing-library/react + MemoryRouter (renders a <Link>); callTool mocked.
// Assertions read container.textContent to sidestep happy-dom's selector
// parser quirks on attribute selectors.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONV_ID = "conv_00000000000000aa";

const DIGEST = {
  conversationId: CONV_ID,
  runId: "run_0001",
  ts: "2026-01-01T00:00:00.000Z",
  sources: [
    { kind: "system_prompt", tokens: 34685 },
    { kind: "tool_descriptions", count: 32, tokens: 4876 },
    { kind: "skills", count: 1, tokens: 1200 },
    { kind: "history", turns: 3, compacted: false, tokens: 30 },
  ],
  excluded: [],
  totalTokens: 40791,
  skills: [
    {
      id: "/workspaces/tenant-a/skills/drafting-craft.md",
      scope: "workspace" as const,
      tokens: 1200,
      loadedBy: "tool_affinity" as const,
      reason: "matched draft__compose",
    },
  ],
};

const EMPTY_DIGEST = {
  conversationId: CONV_ID,
  runId: null,
  ts: null,
  sources: [],
  excluded: [],
  totalTokens: 0,
  skills: [],
};

let digest: unknown = DIGEST;
const callTool = mock(async (server: string, tool: string) => {
  if (server === "compose" && tool === "assembled_context") return { structuredContent: digest };
  throw new Error(`unexpected callTool ${server}__${tool}`);
});

mock.module("../api/client", () => ({ ...realClient, callTool }));

const { InContextPopover } = await import("../components/InContextPopover");

function renderPopover() {
  return render(
    <MemoryRouter>
      <InContextPopover conversationId={CONV_ID} />
    </MemoryRouter>,
  );
}

function open(container: HTMLElement) {
  const btn = Array.from(container.getElementsByTagName("button")).find(
    (b) => b.getAttribute("aria-label") === "In context",
  );
  if (!btn) throw new Error("popover button not found");
  fireEvent.click(btn);
}

describe("InContextPopover", () => {
  test("renders the budget breakdown and the loaded skills", async () => {
    digest = DIGEST;
    const { container } = renderPopover();
    open(container);

    await waitFor(() => expect(container.textContent).toContain("Budget"));
    const text = container.textContent ?? "";

    // Budget — every source + the total.
    expect(text).toContain("System prompt");
    expect(text).toContain("Tools");
    expect(text).toContain("32");
    expect(text).toContain("History");
    expect(text).toContain("3 turns");
    expect(text).toContain("Total");
    expect(text).toContain("40.8k"); // formatTokenCount(40791)

    // Skills — the loaded skill with scope.
    expect(text).toContain("drafting-craft");
    expect(text).toContain("workspace");
  });

  test("shows an empty state when no run has recorded context yet", async () => {
    digest = EMPTY_DIGEST;
    const { container } = renderPopover();
    open(container);

    await waitFor(() => expect(container.textContent).toContain("No context yet"));
    expect(container.textContent).not.toContain("System prompt");
  });
});
