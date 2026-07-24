// ---------------------------------------------------------------------------
// ContextInspectorPage — render contract.
//
// The full-page inspector opened from the In-context panel. Pins:
//   1. The budget bar renders the per-source breakdown + total.
//   2. The composition renders the traced layers; the first layer auto-expands
//      to its composed body.
//   3. Expanding a layer shows that layer's exact body; a second click collapses it.
//   4. A skills layer expands into individual skill bodies; a textless layer
//      (apps) falls back to its aggregate section text.
//   5. A budget bucket (Skills) filters the layer list.
//
// @testing-library/react + MemoryRouter with a param route so useParams
// resolves slug + convId; both compose tool calls mocked. Assertions read
// container.textContent to sidestep happy-dom's attribute-selector quirks.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
    { kind: "skills", count: 1, tokens: 3369 },
    { kind: "history", turns: 3, compacted: false, tokens: 30 },
  ],
  excluded: [],
  totalTokens: 42960,
  skills: [
    {
      id: "/workspaces/tenant-a/skills/drafting-craft.md",
      scope: "workspace" as const,
      tokens: 3369,
      loadedBy: "tool_affinity" as const,
      reason: "matched draft__compose",
    },
  ],
};

const COMPOSITION = {
  mode: "live" as const,
  conversationId: CONV_ID,
  totalTokens: 42960,
  warnings: [],
  layers: [
    {
      kind: "default_identity",
      segment: "stable" as const,
      id: "nb:default-identity",
      source: "platform default identity",
      tokens: 125,
      text: "You are a helpful assistant powered by NimbleBrain.",
    },
    {
      kind: "user_context_skill",
      segment: "stable" as const,
      id: "/workspaces/tenant-a/skills/voice-and-tone/SKILL.md",
      source: "voice-and-tone",
      tokens: 1240,
      text: "Write in plain English. No em-dashes.",
    },
    {
      kind: "layer3_skills",
      segment: "stable" as const,
      id: "nb:layer3-skills",
      source: "layer 3 skills",
      tokens: 3369,
      text: "### drafting-craft\n…combined section…",
      subItems: [
        {
          kind: "layer3_skill" as const,
          id: "/workspaces/tenant-a/skills/drafting-craft.md",
          source: "drafting-craft",
          text: "Open with a specific, verifiable observation.",
          tokens: 1200,
        },
        {
          kind: "layer3_skill" as const,
          id: "/workspaces/tenant-a/skills/batch-first-pass.md",
          source: "batch-first-pass",
          text: "Do a full first pass before revising any item.",
          tokens: 900,
        },
      ],
    },
    {
      // Apps carry per-app sub-items with NO body text (only metadata), so the
      // layer must fall back to its aggregate section rather than itemize — the
      // common production path once a workspace has apps installed.
      kind: "apps",
      segment: "stable" as const,
      id: "nb:apps",
      source: "installed apps (2)",
      tokens: 820,
      text: "## Installed Apps\n\ngranola — meeting notes\nslack — team chat",
      subItems: [
        { kind: "app" as const, id: "granola", source: "granola", bundle: "granola" },
        { kind: "app" as const, id: "slack", source: "slack", bundle: "slack" },
      ],
    },
    {
      kind: "current_date",
      segment: "volatile" as const,
      id: "nb:current-date",
      source: "runtime — current date",
      tokens: 14,
      text: "Thursday, July 23, 2026",
    },
  ],
};

const callTool = mock(async (server: string, tool: string) => {
  if (server === "compose" && tool === "assembled_context") return { structuredContent: DIGEST };
  if (server === "compose" && tool === "effective_context")
    return { structuredContent: COMPOSITION };
  throw new Error(`unexpected callTool ${server}__${tool}`);
});

mock.module("../api/client", () => ({ ...realClient, callTool }));

const { ContextInspectorPage } = await import("../pages/ContextInspectorPage");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/w/abc123/context/${CONV_ID}`]}>
      <Routes>
        <Route path="/w/:slug/context/:convId" element={<ContextInspectorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.getElementsByTagName("button"));
}

describe("ContextInspectorPage", () => {
  test("renders the budget and the composition, with the first layer's body", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("System prompt"));
    await waitFor(() => expect(container.textContent).toContain("Identity (default)"));
    const text = container.textContent ?? "";

    // Budget breakdown + total.
    expect(text).toContain("System prompt");
    expect(text).toContain("Tools");
    expect(text).toContain("History");
    expect(text).toContain("43.0k"); // formatTokenCount(42960)

    // Composition layers. File-backed skills are named by their skill (not the
    // generic kind, and not the raw path), with the kind as a muted descriptor.
    expect(text).toContain("Identity (default)");
    expect(text).toContain("voice-and-tone"); // the skill's name, from its file
    expect(text).toContain("User context skill"); // the kind, as a descriptor
    expect(text).not.toContain("/workspaces/tenant-a"); // raw path is never shown
    expect(text).toContain("Layer-3 skills");
    expect(text).toContain("Current date");
    expect(text).toContain("per-turn"); // volatile marker on current_date

    // The first layer auto-expands to its composed body.
    expect(text).toContain("You are a helpful assistant powered by NimbleBrain.");
  });

  test("shows a layer's composed body when expanded, and collapses on a second click", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("User context skill"));

    const row = buttons(container).find((b) => b.textContent?.includes("User context skill"));
    if (!row) throw new Error("layer row not found");
    fireEvent.click(row);

    await waitFor(() =>
      expect(container.textContent).toContain("Write in plain English. No em-dashes."),
    );

    // A second click collapses it — the body leaves the DOM.
    fireEvent.click(row);
    await waitFor(() =>
      expect(container.textContent).not.toContain("Write in plain English. No em-dashes."),
    );
  });

  test("itemizes a skills layer into individual skill bodies", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("Layer-3 skills"));

    const row = buttons(container).find((b) => b.textContent?.includes("Layer-3 skills"));
    if (!row) throw new Error("layer-3 skills row not found");
    fireEvent.click(row);

    // Each aggregated skill shows its own name and body, not one combined wall.
    await waitFor(() =>
      expect(container.textContent).toContain("Open with a specific, verifiable observation."),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("2 skills"); // the itemization caption
    expect(text).toContain("drafting-craft");
    expect(text).toContain("batch-first-pass");
    expect(text).toContain("Do a full first pass before revising any item.");
    expect(text).not.toContain("…combined section…"); // the aggregate text is not shown
  });

  test("falls back to the aggregate section when sub-items carry no body (apps)", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("Apps"));

    const row = buttons(container).find((b) => b.textContent?.includes("Apps"));
    if (!row) throw new Error("apps row not found");
    fireEvent.click(row);

    // The apps layer renders its composed section text, not a per-item itemization —
    // its sub-items have no body, so there is nothing to break out.
    await waitFor(() => expect(container.textContent).toContain("## Installed Apps"));
    const text = container.textContent ?? "";
    expect(text).toContain("granola — meeting notes");
    expect(text).not.toContain("each shown with its own body"); // not itemized
  });

  test("filters the layers to a budget bucket", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("Identity (default)"));

    // The budget "Skills" bucket (its label starts with "Skills"; the layer is
    // "Layer-3 skills"). Clicking it narrows the list to composed skill layers.
    const skillsBucket = buttons(container).find((b) => b.textContent?.trim().startsWith("Skills"));
    if (!skillsBucket) throw new Error("skills bucket not found");
    fireEvent.click(skillsBucket);

    await waitFor(() => expect(container.textContent).not.toContain("Identity (default)"));
    expect(container.textContent).toContain("Layer-3 skills");
  });
});
