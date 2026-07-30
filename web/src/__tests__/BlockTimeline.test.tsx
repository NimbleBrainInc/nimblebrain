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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { BlockTimeline } = await import("../components/BlockTimeline");
type ContentBlock = import("../hooks/chat-store").ContentBlock;

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
        search("t1", "precision outbound campaign create", 17),
        search("t2", "campaign", 6),
        search("t3", "precision", 5),
      ]),
    ).toEqual({ chips: 1, textItems: 0, blankTextItems: 0 });
  });

  test("blank text between tool rounds neither splits the phase nor renders a spacer", async () => {
    expect(
      await render([
        text("\n"),
        search("t1", "precision outbound campaign create", 17),
        text("\n"),
        search("t2", "campaign", 6),
        text("\n\n"),
        search("t3", "precision", 5),
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
        search("t2", "precision", 5),
      ]),
    ).toEqual({ chips: 2, textItems: 1, blankTextItems: 0 });
  });

  test("reasoning between tool rounds keeps them in one chip", async () => {
    expect(
      await render([
        { type: "reasoning", text: "narrowing the query" },
        search("t1", "campaign", 6),
        { type: "reasoning", text: "still nothing" },
        search("t2", "precision", 5),
      ]),
    ).toEqual({ chips: 1, textItems: 0, blankTextItems: 0 });
  });
});
