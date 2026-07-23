// ---------------------------------------------------------------------------
// LedgerLine — Context Ledger skills line render contract.
//
// Pins:
//   1. At rest: text-only head, no drawer. One skill → "Following <name> ·
//      <stripped reason>"; many → "Following N skills · ~Nk tokens".
//   2. A zero-skill (or absent) turn renders NOTHING — absence is the signal.
//   3. Expanded: trust banner, per-skill rows with scope class + verbatim
//      reason (in `title`) + token count, and the "Manage skills" footer link.
//   4. Name derivation strips `.md` / the `skill://owner/` prefix.
//
// Rendering goes through react-dom/client directly (matching ResourceLinkView's
// test), wrapped in the real WorkspaceProvider (bootstrap mode, so no API call)
// and a MemoryRouter for the footer `<Link>`. WorkspaceContext is NOT
// module-mocked — bun mocks are process-global and would leak this stub into
// the WorkspaceNav / chat-rescope suites that need the real hook. DOM is walked
// via getElementsByTagName + classList — happy-dom's CSS selector engine (which
// querySelector AND getElementsByClassName both route through) throws on these
// class names in this env, so both are deliberately avoided.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { LedgerLine } = await import("../components/LedgerLine");
type SkillsLoadedContext = import("../hooks/chat-store").SkillsLoadedContext;

const WS_ID = "ws_0123456789abcdef";
const BOOTSTRAP_WS = [{ id: WS_ID, name: "Acme", memberCount: 1, bundles: [], isPersonal: true }];

function byClass(root: Element, cls: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((el) => el.classList.contains(cls));
}
function first(root: Element, cls: string): Element | undefined {
  return byClass(root, cls)[0];
}

interface Mounted {
  container: HTMLDivElement;
  head(): HTMLButtonElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function mount(skills: SkillsLoadedContext | undefined): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        WorkspaceProvider,
        { initialWorkspaces: BOOTSTRAP_WS, initialActiveId: WS_ID },
        React.createElement(MemoryRouter, null, React.createElement(LedgerLine, { skills })),
      ),
    );
  });
  return {
    container,
    head: () => first(container, "ledger-line__head") as HTMLButtonElement,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const ONE: SkillsLoadedContext = {
  skills: [
    {
      id: "skills/mpak-guide.md",
      scope: "workspace",
      tokens: 1200,
      loadedBy: "tool_affinity",
      reason: "tool-affinity matched mpak__*",
    },
  ],
  totalTokens: 1200,
};

const TWO: SkillsLoadedContext = {
  skills: [
    ONE.skills[0]!,
    {
      id: "skill://acme/release-notes",
      scope: "bundle",
      tokens: 610,
      loadedBy: "tool_affinity",
      reason: "tool-affinity matched registry__status",
    },
  ],
  totalTokens: 1810,
};

describe("LedgerLine", () => {
  test("renders nothing for an absent or zero-skill turn", async () => {
    mounted = await mount(undefined);
    expect(mounted.container.textContent).toBe("");
    mounted.unmount();
    mounted = await mount({ skills: [], totalTokens: 0 });
    expect(mounted.container.textContent).toBe("");
  });

  test("single skill: head shows the name and the stripped reason, no drawer at rest", async () => {
    mounted = await mount(ONE);
    const head = mounted.head();
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.textContent).toContain("Following mpak-guide");
    // The `tool-affinity ` mechanism prefix is stripped for the compact head.
    expect(head.textContent).toContain("matched mpak__*");
    expect(head.textContent).not.toContain("tool-affinity matched");
    // No drawer until expanded.
    expect(byClass(mounted.container, "ledger-line__body")).toHaveLength(0);
  });

  test("multiple skills: head folds to a count and the aggregate token cost", async () => {
    mounted = await mount(TWO);
    const head = mounted.head();
    expect(head.textContent).toContain("Following 2 skills");
    expect(head.textContent).toContain("~1.8k tokens");
  });

  test("expanded: trust banner, verbatim reason in title, scope class, tokens, manage link", async () => {
    mounted = await mount(TWO);
    await click(mounted.head());
    const { container } = mounted;

    expect(mounted.head().getAttribute("aria-expanded")).toBe("true");
    expect(first(container, "ledger-line__trust")?.textContent).toContain(
      "composed into the agent's instructions",
    );

    const rows = byClass(container, "ledger-line__row");
    expect(rows).toHaveLength(2);

    // Row 1: workspace scope, name derived, verbatim reason preserved in title.
    expect(first(rows[0]!, "ledger-line__row-name")?.textContent).toBe("mpak-guide");
    expect(first(rows[0]!, "ledger-scope--workspace")).toBeDefined();
    expect(first(rows[0]!, "ledger-line__row-detail")?.getAttribute("title")).toBe(
      "tool-affinity matched mpak__*",
    );
    expect(first(rows[0]!, "ledger-line__row-tok")?.textContent).toBe("1.2k tok");

    // Row 2: bundle scope, name derived from a `skill://owner/name` id.
    expect(first(rows[1]!, "ledger-line__row-name")?.textContent).toBe("release-notes");
    expect(first(rows[1]!, "ledger-scope--bundle")).toBeDefined();

    const link = container.getElementsByTagName("a")[0];
    expect(link?.textContent).toContain("Manage skills");
    expect(link?.getAttribute("href")).toContain("/settings/skills");
  });
});
