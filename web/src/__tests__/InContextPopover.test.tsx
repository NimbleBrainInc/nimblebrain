// ---------------------------------------------------------------------------
// InContextPopover — render contract.
//
// The header affordance answers "what's equipping this conversation" from the
// recorded run digest (`compose.assembled_context` — one read powers both
// sections). Pins:
//   1. The window section renders the three disjoint regions, nests the skills
//      slice under the system prompt, and totals only the disjoint sum — the
//      recorded `totalTokens` counts composed skill bodies twice.
//   2. The Skills section groups by why each skill loaded, and names the
//      publishing connector rather than the tier.
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
    // Not a fourth region — this measures how much of `system_prompt` the
    // composed skill bodies account for.
    { kind: "skills", count: 2, tokens: 2100 },
    { kind: "history", messages: 3, compacted: false, tokens: 30 },
  ],
  excluded: [],
  // As recorded: the sum of all four rows, so the 2100 is in here twice.
  totalTokens: 41691,
  skills: [
    {
      id: "/workspaces/tenant-a/skills/drafting-craft.md",
      name: "drafting-craft",
      scope: "workspace" as const,
      tokens: 1200,
      loadedBy: "always" as const,
      reason: "always-on",
    },
    {
      id: "skill://acme/usage/SKILL.md",
      name: "usage",
      connector: "acme-mcp",
      scope: "bundle" as const,
      tokens: 900,
      loadedBy: "tool_affinity" as const,
      reason: "tool-affinity matched acme-mcp__*",
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
  test("renders the window breakdown with skills nested under the system prompt", async () => {
    digest = DIGEST;
    const { container } = renderPopover();
    open(container);

    await waitFor(() => expect(container.textContent).toContain("Context window"));
    const text = container.textContent ?? "";

    expect(text).toContain("System prompt");
    expect(text).toContain("of which skills");
    expect(text).toContain("Tools");
    expect(text).toContain("32");
    expect(text).toContain("History");
    // The count is messages, which is what the runtime records.
    expect(text).toContain("3 messages");
  });

  test("totals the window, not the recorded sum that counts skills twice", async () => {
    digest = DIGEST;
    const { container } = renderPopover();
    open(container);

    await waitFor(() => expect(container.textContent).toContain("Context window"));
    const text = container.textContent ?? "";

    // 34685 + 4876 + 30 = 39591. The recorded 41691 adds the 2100 of skill
    // bodies a second time, having already counted them inside system_prompt.
    expect(text).toContain("39.6k");
    expect(text).not.toContain("41.7k");
    expect(text).toContain("In the window");
  });

  test("groups skills by why they loaded and names the publishing connector", async () => {
    digest = DIGEST;
    const { container } = renderPopover();
    open(container);

    await waitFor(() => expect(container.textContent).toContain("Skills"));
    const text = container.textContent ?? "";

    expect(text).toContain("Always on");
    expect(text).toContain("Matched your tools");

    expect(text).toContain("drafting-craft");
    expect(text).toContain("workspace");

    // The connector skill renders its own name (its id ends in `/SKILL.md`)
    // and attributes the publisher instead of showing the wire tier.
    expect(text).toContain("usage");
    expect(text).toContain("acme-mcp");
    expect(text).not.toContain("SKILL.md");
    expect(text).not.toContain("bundle");
  });

  test("shows an empty state when no run has recorded context yet", async () => {
    digest = EMPTY_DIGEST;
    const { container } = renderPopover();
    open(container);

    await waitFor(() => expect(container.textContent).toContain("No context yet"));
    expect(container.textContent).not.toContain("System prompt");
  });
});
