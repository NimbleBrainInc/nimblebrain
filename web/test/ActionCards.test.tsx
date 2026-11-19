// ActionCards — render contract for the overview's next steps: the first few
// cards, the rest folded, hiding an alert until it changes, and the briefing's
// error. Uses the container/createRoot harness; query via testids.

import { afterEach, describe, expect, test } from "bun:test";
import type { OverviewAction } from "../src/components/overview/actions";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ActionCards, MAX_SHOWN } = await import("../src/components/overview/ActionCards");

interface Mounted {
  container: HTMLDivElement;
  rerender(el: React.ReactElement): Promise<void>;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  localStorage.clear();
});

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    async rerender(el) {
      await act(async () => {
        root.render(el);
      });
    },
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function byTestId(c: HTMLElement, id: string): HTMLElement[] {
  return Array.from(c.getElementsByTagName("*")).filter(
    (el) => el.getAttribute("data-testid") === id,
  ) as HTMLElement[];
}

const one = (c: HTMLElement, id: string) => byTestId(c, id)[0] ?? null;

function alert(key: string, signature: string, over: Partial<OverviewAction> = {}): OverviewAction {
  return {
    key,
    signature,
    level: "warning",
    count: 2,
    title: key,
    detail: "CRM",
    verb: "Open",
    muted: false,
    target: { type: "navigate", to: "/w/acme/app/crm" },
    testId: "overview-action-facet",
    ...over,
  };
}

function setup(key: string): OverviewAction {
  return {
    key: `setup:${key}`,
    signature: null,
    level: "none",
    count: null,
    title: key,
    detail: "",
    verb: "Go",
    muted: false,
    target: { type: "navigate", to: "/" },
    testId: `overview-action-setup-${key}`,
  };
}

const WS = "ws_0076759dbbe19fcc";

function view(
  actions: OverviewAction[],
  over: {
    onChoose?: (a: OverviewAction) => void;
    error?: string | null;
    onRetry?: () => void;
  } = {},
) {
  return (
    <ActionCards
      workspaceId={WS}
      actions={actions}
      error={over.error ?? null}
      onRetry={over.onRetry ?? (() => {})}
      onChoose={over.onChoose ?? (() => {})}
    />
  );
}

const titles = (c: HTMLElement) =>
  Array.from(c.getElementsByTagName("li")).map((li) => li.getAttribute("data-testid"));

async function click(el: HTMLElement | null | undefined) {
  await act(async () => {
    el?.click();
  });
}

describe("ActionCards", () => {
  test("renders nothing with no actions and no error", async () => {
    mounted = await mount(view([]));
    expect(one(mounted.container, "overview-actions")).toBeNull();
  });

  test("a card says its count, title and source, and choosing it hands back the action", async () => {
    const chosen: string[] = [];
    mounted = await mount(
      view([alert("Follow-ups", "ok:2")], { onChoose: (a) => chosen.push(a.key) }),
    );
    const card = one(mounted.container, "overview-action-facet");
    expect(card?.textContent).toBe("Warning: 2Follow-ups · CRMOpen →");
    await click(card?.getElementsByTagName("button")[0]);
    expect(chosen).toEqual(["Follow-ups"]);
  });

  test("an alert heads the section as Needs you, setup as Get started", async () => {
    mounted = await mount(view([alert("a", "ok:1")]));
    expect(one(mounted.container, "overview-actions")?.getAttribute("aria-label")).toBe(
      "Needs you",
    );
    await mounted.rerender(view([setup("plugin")]));
    expect(one(mounted.container, "overview-actions")?.getAttribute("aria-label")).toBe(
      "Get started",
    );
  });

  test(`shows the first ${MAX_SHOWN}, folds the rest, and Show more reveals them`, async () => {
    const actions = ["a", "b", "c", "d", "e"].map((k) => alert(k, "ok:1", { testId: k }));
    mounted = await mount(view(actions));
    expect(titles(mounted.container)).toEqual(["a", "b", "c"]);
    const more = one(mounted.container, "overview-actions-more");
    expect(more?.textContent).toBe("Show 2 more");
    await click(more);
    expect(titles(mounted.container)).toEqual(["a", "b", "c", "d", "e"]);
    expect(one(mounted.container, "overview-actions-more")?.textContent).toBe("Show fewer");
  });

  test("setup cards cannot be hidden", async () => {
    mounted = await mount(view([setup("plugin")]));
    expect(one(mounted.container, "overview-action-hide")).toBeNull();
  });

  test("a card with no target is not a button that does anything", async () => {
    mounted = await mount(view([alert("a", "ok:1", { target: { type: "none" } })]));
    const button = one(mounted.container, "overview-action-facet")?.getElementsByTagName(
      "button",
    )[0] as HTMLButtonElement | undefined;
    expect(button?.disabled).toBe(true);
  });

  describe("hiding an alert until it changes", () => {
    test("hides it, counts it, and Show brings it back", async () => {
      mounted = await mount(view([alert("a", "ok:2"), alert("b", "ok:1", { testId: "b" })]));
      await click(one(mounted.container, "overview-action-hide"));
      expect(titles(mounted.container)).toEqual(["b"]);
      const show = one(mounted.container, "overview-actions-show-hidden");
      expect(show?.textContent).toBe("1 hidden · Show");
      await click(show);
      expect(titles(mounted.container)).toEqual(["overview-action-facet", "b"]);
    });

    test("stays hidden across a remount while the count holds or falls", async () => {
      mounted = await mount(view([alert("a", "ok:2")]));
      await click(one(mounted.container, "overview-action-hide"));
      mounted.unmount();
      mounted = await mount(view([alert("a", "ok:1")]));
      expect(titles(mounted.container)).toEqual([]);
    });

    test("comes back when the count rises", async () => {
      mounted = await mount(view([alert("a", "ok:2")]));
      await click(one(mounted.container, "overview-action-hide"));
      await mounted.rerender(view([alert("a", "ok:3")]));
      expect(titles(mounted.container)).toEqual(["overview-action-facet"]);
    });

    test("forgets a hidden alert that went away, so its return shows", async () => {
      mounted = await mount(view([alert("a", "ok:2")]));
      await click(one(mounted.container, "overview-action-hide"));
      await mounted.rerender(view([]));
      await mounted.rerender(view([alert("a", "ok:2")]));
      expect(titles(mounted.container)).toEqual(["overview-action-facet"]);
    });

    test("is scoped to the workspace", async () => {
      mounted = await mount(view([alert("a", "ok:2")]));
      await click(one(mounted.container, "overview-action-hide"));
      expect(localStorage.getItem(`nb:briefing:${WS}`)).toContain('"a":"ok:2"');
    });
  });

  test("renders an error with a working Retry", async () => {
    let retried = 0;
    mounted = await mount(view([], { error: "Failed to collect", onRetry: () => retried++ }));
    const err = one(mounted.container, "overview-actions-error");
    expect(err?.textContent).toContain("Failed to collect");
    await click(err?.getElementsByTagName("button")[0]);
    expect(retried).toBe(1);
  });
});
