// ---------------------------------------------------------------------------
// BlockTimeline — phase segmentation contract.
//
// Pins the rule that decides how many activity chips a turn renders, and the
// vertical rhythm that follows from it:
//
//   1. Consecutive same-tool blocks fold into ONE chip (`×N`), because they are
//      one phase of work.
//   2. A text block carrying no visible prose is neither an element nor a phase
//      boundary. Providers emit a bare newline between thinking→act rounds;
//      rendering it reserves an empty `min-h-[1em]` line and splits the phase,
//      which reads as ~28px of unexplained gap per round.
//   3. Real prose DOES break the phase — "tools → text → tools" stays three
//      elements.
//
// Rendering goes through react-dom/client directly (matching LedgerLine's
// test). DOM is walked via getElementsByTagName + classList — happy-dom's CSS
// selector engine throws on these class names in this env, so querySelector and
// getElementsByClassName are both deliberately avoided.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { BlockTimeline } = await import("../components/BlockTimeline");
const { ArtifactPanelProvider } = await import("../context/ArtifactPanelContext");
type ContentBlock = import("../hooks/chat-store").ContentBlock;
type ToolCallDisplay = import("../hooks/chat-store").ToolCallDisplay;

function byClass(root: Element, cls: string): Element[] {
  return Array.from(root.getElementsByTagName("*")).filter((el) => el.classList.contains(cls));
}

function search(id: string, query: string, ms: number): ContentBlock {
  return {
    type: "tool",
    toolCalls: [
      {
        id,
        name: "nb__search",
        status: "done",
        input: { query },
        result: { content: [{ type: "text", text: "results" }], isError: false },
        ms,
      },
    ],
  };
}

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

interface Rendered {
  /** Top-level activity chips. */
  chips: number;
  /** Rendered text items — the `min-h-[1em]` prose wrappers. */
  textItems: number;
  /** Text items that paint nothing: the phantom spacers. */
  blankTextItems: number;
}

async function render(blocks: ContentBlock[]): Promise<Rendered> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(BlockTimeline, {
        blocks,
        isCurrentMessage: false,
        streamingState: null,
        preparingTool: null,
        displayDetail: "balanced",
      }),
    );
  });
  const textItems = Array.from(container.getElementsByTagName("div")).filter((d) =>
    d.classList.contains("min-h-[1em]"),
  );
  const out: Rendered = {
    chips: byClass(container, "turn-pill").length,
    textItems: textItems.length,
    blankTextItems: textItems.filter((d) => (d.textContent ?? "").trim().length === 0).length,
  };
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return out;
}

describe("BlockTimeline phase segmentation", () => {
  test("consecutive same-tool blocks fold into one chip", async () => {
    expect(
      await render([
        search("t1", "acme outbound campaign create", 17),
        search("t2", "campaign", 6),
        search("t3", "acme", 5),
      ]),
    ).toEqual({ chips: 1, textItems: 0, blankTextItems: 0 });
  });

  test("blank text between tool rounds neither splits the phase nor renders a spacer", async () => {
    expect(
      await render([
        text("\n"),
        search("t1", "acme outbound campaign create", 17),
        text("\n"),
        search("t2", "campaign", 6),
        text("\n\n"),
        search("t3", "acme", 5),
        text("   "),
      ]),
    ).toEqual({ chips: 1, textItems: 0, blankTextItems: 0 });
  });

  test("a blank block does not suppress the prose that follows it", async () => {
    expect(
      await render([search("t1", "campaign", 6), text("\n"), text("Here is what I found.")]),
    ).toEqual({
      chips: 1,
      textItems: 1,
      blankTextItems: 0,
    });
  });

  test("real prose breaks the phase", async () => {
    expect(
      await render([
        search("t1", "campaign", 6),
        text("Let me widen the search."),
        search("t2", "acme", 5),
      ]),
    ).toEqual({ chips: 2, textItems: 1, blankTextItems: 0 });
  });

  test("reasoning between tool rounds keeps them in one chip", async () => {
    expect(
      await render([
        { type: "reasoning", text: "narrowing the query" },
        search("t1", "campaign", 6),
        { type: "reasoning", text: "still nothing" },
        search("t2", "acme", 5),
      ]),
    ).toEqual({ chips: 1, textItems: 0, blankTextItems: 0 });
  });
});

describe("BlockTimeline resource links", () => {
  /** A completed call from `appName` that returns one markdown resource link. */
  function linkCall(id: string, appName: string, uri: string): ToolCallDisplay {
    return {
      id,
      name: `${appName}__info`,
      status: "done",
      appName,
      resourceLinks: [{ uri, name: "notes.md", mimeType: "text/markdown" }],
      result: { content: [{ type: "text", text: "ok" }], isError: false },
      ms: 3,
    };
  }

  function linked(id: string, appName: string, uri: string): ContentBlock {
    return { type: "tool", toolCalls: [linkCall(id, appName, uri)] };
  }

  /** The `Open <title>` document chips the turn renders, one per shown link. */
  async function linkCards(blocks: ContentBlock[]): Promise<number> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          ArtifactPanelProvider,
          null,
          React.createElement(BlockTimeline, {
            blocks,
            isCurrentMessage: false,
            streamingState: null,
            preparingTool: null,
            displayDetail: "balanced",
          }),
        ),
      );
    });
    const cards = Array.from(container.getElementsByTagName("button")).filter((b) =>
      (b.getAttribute("aria-label") ?? "").startsWith("Open "),
    ).length;
    await act(async () => {
      root.unmount();
    });
    container.remove();
    return cards;
  }

  test("one file named twice in a turn shows once, even across prose", async () => {
    expect(
      await linkCards([
        linked("t1", "files", "files://fl_abc"),
        text("Saved it. Here it is again."),
        linked("t2", "files", "files://fl_abc"),
      ]),
    ).toBe(1);
  });

  test("the same URI from two sources is two resources and shows twice", async () => {
    expect(
      await linkCards([
        {
          type: "tool",
          toolCalls: [
            linkCall("t1", "docs", "report://latest"),
            linkCall("t2", "my_docs", "report://latest"),
          ],
        },
      ]),
    ).toBe(2);
  });
});
