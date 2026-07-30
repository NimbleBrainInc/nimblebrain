// ---------------------------------------------------------------------------
// ContextInspectorPage — render contract.
//
// The full-page inspector opened from the In-context panel. Pins:
//   1. The budget bar renders the per-source breakdown + total.
//   2. The composition renders the traced layers; the first layer auto-expands
//      to its composed body.
//   3. Expanding a layer shows that layer's exact composed text; a second click
//      collapses it. A skills layer shows the section verbatim — the ## Skills
//      header, each skill's provenance line, and the <layer3-skill> containment
//      wrapper — because that is what actually entered the window.
//   4. A budget bucket (Skills) filters the layer list.
//
// @testing-library/react + MemoryRouter with a param route so useParams
// resolves slug + convId; both compose tool calls mocked. Assertions read
// container.textContent to sidestep happy-dom's attribute-selector quirks.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
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
    { kind: "skills", count: 1, tokens: 3369, annotation: true },
    { kind: "history", messages: 3, compacted: false, tokens: 30 },
  ],
  excluded: [],
  totalTokens: 42960,
  windowTokens: 39591,
  skills: [
    {
      id: "/workspaces/tenant-a/skills/drafting-craft.md",
      name: "drafting-craft",
      scope: "workspace" as const,
      tokens: 3369,
      loadedBy: "tool_affinity" as const,
      reason: "matched draft__compose",
    },
  ],
};

// The layer-3 skills layer carries its composed section as `text` — the exact
// bytes the runtime placed in the prompt, including the provenance line and the
// <layer3-skill> containment wrapper. The inspector renders that verbatim.
const SKILLS_SECTION = [
  "## Skills",
  "",
  "### drafting-craft",
  "",
  "_drafting-craft_ — scope: workspace; loaded: tool_affinity (matched draft__compose)",
  "",
  "<layer3-skill>",
  "Open with a specific, verifiable observation.",
  "</layer3-skill>",
].join("\n");

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
      text: SKILLS_SECTION,
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

// A conversation whose budget (assembled_context) read fails — used to prove a
// switch surfaces B's error rather than leaving A's budget on screen.
const CONV_BUDGET_FAIL = "conv_00000000000000ff";

// The production shape this page got wrong: a turn that loaded real skills
// (recorded, 7.2k) whose LIVE recomposition holds no layer-3 section. Nothing
// exotic — a trigger match needs the user's message and can't recompose, and
// always-on skills compose into their own layers, so a live trace legitimately
// has no layer-3 section while the recorded turn loaded plenty. Filtering the
// live layers by that section reported "no skills" under a card reading 7.2k.
const CONV_NO_LIVE_L3 = "conv_00000000000000cc";
const DIGEST_NO_LIVE_L3 = {
  ...DIGEST,
  conversationId: CONV_NO_LIVE_L3,
  sources: [
    { kind: "system_prompt", tokens: 34685 },
    { kind: "tool_descriptions", count: 32, tokens: 4876 },
    { kind: "skills", count: 3, tokens: 7200, annotation: true },
    { kind: "history", messages: 3, compacted: false, tokens: 30 },
  ],
  skills: [
    {
      id: "/workspaces/tenant-a/skills/house-style.md",
      name: "house-style",
      scope: "workspace" as const,
      tokens: 2100,
      loadedBy: "always" as const,
      reason: "always-on",
    },
    {
      id: "skill://usage/SKILL.md",
      name: "usage",
      connector: "acme-crm",
      scope: "bundle" as const,
      tokens: 3900,
      loadedBy: "tool_affinity" as const,
      reason: "tool-affinity matched acme-crm__*",
    },
    {
      id: "/workspaces/tenant-a/skills/release-notes.md",
      name: "release-notes",
      scope: "workspace" as const,
      tokens: 1200,
      loadedBy: "trigger" as const,
      reason: 'trigger matched "cut a release"',
    },
  ],
};
const COMPOSITION_NO_LIVE_L3 = {
  ...COMPOSITION,
  conversationId: CONV_NO_LIVE_L3,
  layers: COMPOSITION.layers.filter((l) => l.kind !== "layer3_skills"),
};

// A conversation whose reads are held open, to prove that a slow read from a
// conversation the user navigated away from is ignored rather than landing in
// the new view. Its reads resolve to a distinctive body once released.
const CONV_STALE = "conv_0000000000000aaa";
const STALE_BODY = "STALE-BODY-FROM-PREVIOUS-CONVERSATION";
let releaseStale: () => void = () => {};
const staleGate = new Promise<void>((r) => {
  releaseStale = r;
});
const staleReads: Promise<unknown>[] = [];

const callTool = mock(async (server: string, tool: string, args?: { conversation_id?: string }) => {
  const cid = args?.conversation_id;
  if (server === "compose" && tool === "assembled_context") {
    if (cid === CONV_BUDGET_FAIL) throw new Error("BUDGET-READ-FAILED-FOR-B");
    if (cid === CONV_NO_LIVE_L3) return { structuredContent: DIGEST_NO_LIVE_L3 };
    if (cid === CONV_STALE) {
      const p = staleGate.then(() => ({
        structuredContent: { ...DIGEST, conversationId: CONV_STALE },
      }));
      staleReads.push(p);
      return p;
    }
    return { structuredContent: DIGEST };
  }
  if (server === "compose" && tool === "effective_context") {
    if (cid === CONV_NO_LIVE_L3) return { structuredContent: COMPOSITION_NO_LIVE_L3 };
    if (cid === CONV_STALE) {
      const p = staleGate.then(() => ({
        structuredContent: {
          ...COMPOSITION,
          conversationId: CONV_STALE,
          layers: [
            {
              kind: "default_identity",
              segment: "stable" as const,
              id: "nb:default-identity",
              source: "stale identity",
              tokens: 100,
              text: STALE_BODY,
            },
          ],
        },
      }));
      staleReads.push(p);
      return p;
    }
    return { structuredContent: COMPOSITION };
  }
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

    // Budget breakdown + the window total, stated once (in the header).
    expect(text).toContain("System prompt");
    expect(text).toContain("Tools");
    expect(text).toContain("History");
    expect(text).toContain("3 messages");
    // The window is the disjoint sum (34685 + 4876 + 30); the recorded 42960
    // adds the 3369 of skill bodies a second time, having already counted them
    // inside the system prompt.
    expect(text).toContain("39.6k");
    expect(text).not.toContain("43.0k");
    expect(text.match(/39\.6k/g)).toHaveLength(1);

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

  test("expands a layer to its composed body, and collapses on a second click", async () => {
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

  test("shows the skills section verbatim — provenance line and containment wrapper", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("Layer-3 skills"));

    const row = buttons(container).find((b) => b.textContent?.includes("Layer-3 skills"));
    if (!row) throw new Error("layer-3 skills row not found");
    fireEvent.click(row);

    await waitFor(() =>
      expect(container.textContent).toContain("Open with a specific, verifiable observation."),
    );
    const text = container.textContent ?? "";
    // The exact composed text, not a re-derived clean copy: the section header,
    // the provenance line, and the containment wrapper all render.
    expect(text).toContain("## Skills");
    expect(text).toContain("scope: workspace; loaded: tool_affinity");
    expect(text).toContain("<layer3-skill>");
  });

  test("re-arms the first-layer auto-open when the conversation changes", async () => {
    // The inspector route element is reused across a :convId change (the docked
    // chat stays mounted), so the auto-open latch and expansion state must reset
    // per conversation — otherwise B inherits A's expansion (or shows nothing).
    const CONV_B = "conv_00000000000000bb";
    function Nav() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(`/w/abc123/context/${CONV_B}`)}>
          go-to-b
        </button>
      );
    }
    const { container } = render(
      <MemoryRouter initialEntries={[`/w/abc123/context/${CONV_ID}`]}>
        <Nav />
        <Routes>
          <Route path="/w/:slug/context/:convId" element={<ContextInspectorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // A mounts with its first layer auto-expanded.
    await waitFor(() =>
      expect(container.textContent).toContain(
        "You are a helpful assistant powered by NimbleBrain.",
      ),
    );

    // User collapses it — nothing is expanded now.
    const idRow = buttons(container).find((b) => b.textContent?.includes("Identity (default)"));
    if (!idRow) throw new Error("identity row not found");
    fireEvent.click(idRow);
    await waitFor(() =>
      expect(container.textContent).not.toContain(
        "You are a helpful assistant powered by NimbleBrain.",
      ),
    );

    // Switch conversations on the reused route element: the first layer must
    // auto-expand again rather than staying collapsed from A.
    const go = buttons(container).find((b) => b.textContent?.includes("go-to-b"));
    if (!go) throw new Error("nav button not found");
    fireEvent.click(go);

    await waitFor(() =>
      expect(container.textContent).toContain(
        "You are a helpful assistant powered by NimbleBrain.",
      ),
    );
  });

  test("surfaces the new conversation's budget error rather than leaving the old budget on screen", async () => {
    function Nav() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(`/w/abc123/context/${CONV_BUDGET_FAIL}`)}>
          go-fail
        </button>
      );
    }
    const { container } = render(
      <MemoryRouter initialEntries={[`/w/abc123/context/${CONV_ID}`]}>
        <Nav />
        <Routes>
          <Route path="/w/:slug/context/:convId" element={<ContextInspectorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // A's budget loads.
    await waitFor(() => expect(container.textContent).toContain("39.6k"));

    // Switch to a conversation whose budget read fails. The prior budget must
    // not linger as B's, and the error must surface (both gate on an absent
    // digest, so the switch has to clear it).
    const go = buttons(container).find((b) => b.textContent?.includes("go-fail"));
    if (!go) throw new Error("nav button not found");
    fireEvent.click(go);

    await waitFor(() => expect(container.textContent).toContain("BUDGET-READ-FAILED-FOR-B"));
    expect(container.textContent).not.toContain("39.6k");
  });

  test("ignores a slow read from a conversation the user has navigated away from", async () => {
    const CONV_FRESH = "conv_0000000000000bbb";
    function Nav() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate(`/w/abc123/context/${CONV_FRESH}`)}>
          go-fresh
        </button>
      );
    }
    const { container } = render(
      <MemoryRouter initialEntries={[`/w/abc123/context/${CONV_STALE}`]}>
        <Nav />
        <Routes>
          <Route path="/w/:slug/context/:convId" element={<ContextInspectorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // CONV_STALE's reads are held open — the page is still loading.
    await waitFor(() => expect(container.textContent).toContain("Loading context"));

    // Navigate to a fresh conversation whose reads resolve immediately.
    const go = buttons(container).find((b) => b.textContent?.includes("go-fresh"));
    if (!go) throw new Error("nav button not found");
    fireEvent.click(go);
    await waitFor(() =>
      expect(container.textContent).toContain(
        "You are a helpful assistant powered by NimbleBrain.",
      ),
    );

    // Release the previous conversation's slow reads. Their late resolution must
    // not overwrite the current view (the fix ignores a cancelled load's setters).
    await act(async () => {
      releaseStale();
      await Promise.allSettled(staleReads);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain(STALE_BODY);
    expect(container.textContent).toContain("You are a helpful assistant powered by NimbleBrain.");
  });

  test("drilling into a budget bucket filters and reveals that layer", async () => {
    const { container } = renderPage();
    await waitFor(() => expect(container.textContent).toContain("Identity (default)"));

    // The budget "Skills" bucket (its label starts with "Skills"; the layer is
    // "Layer-3 skills"). Clicking it narrows the list to composed skill layers
    // and opens the drilled layer rather than landing on a collapsed row.
    const skillsBucket = buttons(container).find((b) => b.textContent?.trim().startsWith("Skills"));
    if (!skillsBucket) throw new Error("skills bucket not found");
    fireEvent.click(skillsBucket);

    await waitFor(() => expect(container.textContent).not.toContain("Identity (default)"));
    expect(container.textContent).toContain("Layer-3 skills");
    // The drilled layer is expanded — its composed section is on screen.
    expect(container.textContent).toContain("## Skills");
  });

  test("the skills bucket lists the recorded turn's skills, whatever the live composition holds", async () => {
    // The card counts a recording, so the drill-down reads the same recording
    // rather than the live recomposition beside it. Every mechanism the turn
    // used has to appear — the live trace can only ever hold tool-affinity.
    const { container } = render(
      <MemoryRouter initialEntries={[`/w/abc123/context/${CONV_NO_LIVE_L3}`]}>
        <Routes>
          <Route path="/w/:slug/context/:convId" element={<ContextInspectorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.textContent).toContain("Identity (default)"));

    const skillsBucket = buttons(container).find((b) => b.textContent?.trim().startsWith("Skills"));
    if (!skillsBucket) throw new Error("skills bucket not found");
    fireEvent.click(skillsBucket);

    await waitFor(() => expect(container.textContent).toContain("house-style"));
    const text = container.textContent ?? "";

    // All three mechanisms, under their headings.
    expect(text).toContain("Always on");
    expect(text).toContain("Matched your tools");
    expect(text).toContain("Matched what you said");
    expect(text).toContain("house-style");
    expect(text).toContain("usage");
    expect(text).toContain("release-notes");

    // Provenance: a connector skill is labelled by its publisher, a filesystem
    // skill by its tier. Per-skill costs sum to the 7.2k on the card.
    expect(text).toContain("acme-crm");
    expect(text).toContain("workspace");
    expect(text).toContain("2.1k");
    expect(text).toContain("3.9k");
    expect(text).toContain("1.2k");
    expect(text).toContain("7.2k");

    // And no "nothing loaded" line under a card that just counted three skills.
    expect(text).not.toContain("No matched skills");
    expect(text).not.toContain("Nothing composes");
  });
});
