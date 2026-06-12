// ---------------------------------------------------------------------------
// ArtifactPanel + ArtifactChip — document-artifact render contract.
//
// Pins the UX-option-B behavior: a resource_link document artifact renders as
// a compact chip in the chat stream (NOT a raw-markdown box); clicking Open
// fetches the resource via readResource and renders it as RENDERED markdown
// (real <a>/<h1> elements, not literal `[text](url)` / `# Heading` syntax) in
// the document panel, with copy + download actions; a fetch failure shows the
// error state.
//
// Mirrors ResourceLinkView.test.tsx: rendering goes through react-dom/client
// directly (no @testing-library/react — happy-dom's selector parser throws on
// some testing-library inputs), and api/client is whole-module-mocked with
// only readResource overridden (spread the preload snapshot so ApiClientError
// and every other export stay real).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const readResourceMock = mock(
  async (_server: string, _uri: string): Promise<{ contents: unknown[] }> => ({ contents: [] }),
);

mock.module("../api/client", () => ({
  ...realClient,
  readResource: readResourceMock,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ArtifactChip } = await import("../components/ArtifactChip");
const { ArtifactPanel } = await import("../components/ArtifactPanel");
const { ArtifactPanelProvider } = await import("../context/ArtifactPanelContext");

beforeEach(() => {
  readResourceMock.mockReset();
});

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const CHIP_PROPS = {
  appName: "nb",
  uri: "files://rpt_abc123",
  name: "Quantum Computing Market Report",
  mimeType: "text/markdown",
} as const;

/** Mount the chip + the global panel under one provider, the real wiring. */
async function mountSurface(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        ArtifactPanelProvider,
        null,
        React.createElement(ArtifactChip, CHIP_PROPS),
        React.createElement(ArtifactPanel),
      ),
    );
  });
  await settle();
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  // Several awaited microtask hops: openArtifact (sync) → effect fires the
  // async readResource → setState commits the body → Streamdown renders.
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function findOpenButton(container: HTMLElement): HTMLButtonElement {
  const btn = Array.from(container.getElementsByTagName("button")).find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith("Open "),
  );
  if (!btn) throw new Error(`chip Open button missing. html=${container.innerHTML.slice(0, 300)}`);
  return btn as HTMLButtonElement;
}

describe("ArtifactChip", () => {
  test("renders a compact chip from a resource_link, with title and Open affordance", async () => {
    mounted = await mountSurface();
    expect(mounted.container.textContent).toContain("Quantum Computing Market Report");
    expect(mounted.container.textContent).toContain("Report"); // mime-derived kind label
    // The chip carries only the ref — no fetch happens until Open is clicked.
    expect(readResourceMock.mock.calls.length).toBe(0);
    findOpenButton(mounted.container); // throws if absent
  });

  test("clicking Open triggers the fetch and renders MARKDOWN (real anchors, not raw)", async () => {
    readResourceMock.mockImplementation(async () => ({
      contents: [
        {
          uri: CHIP_PROPS.uri,
          mimeType: "text/markdown",
          text: "# Findings\n\nSee [the source](https://example.com/source) for detail.",
        },
      ],
    }));

    mounted = await mountSurface();
    const open = findOpenButton(mounted.container);
    await act(async () => {
      open.click();
    });
    await settle();

    expect(readResourceMock.mock.calls.length).toBe(1);
    expect(readResourceMock.mock.calls[0]).toEqual(["nb", "files://rpt_abc123"]);

    // Rendered markdown: a real heading element + a rendered link element
    // (Streamdown — the same renderer the chat uses — emits links as
    // interactive elements tagged data-streamdown="link", not raw syntax).
    const headings = mounted.container.getElementsByTagName("h1");
    expect(headings.length).toBeGreaterThan(0);
    expect(headings[0]?.textContent).toContain("Findings");
    // happy-dom's querySelectorAll parser throws on attribute selectors (see
    // ResourceLinkView.test.tsx header), so scan elements by tag/attr instead.
    const link = Array.from(mounted.container.getElementsByTagName("*")).find(
      (el) => el.getAttribute("data-streamdown") === "link",
    );
    if (!link) {
      throw new Error(`rendered link missing. html=${mounted.container.innerHTML.slice(0, 600)}`);
    }
    expect(link.textContent).toContain("the source");
    // The raw markdown syntax must NOT appear as literal text — proof we're
    // rendering, not dumping a cramped raw-markdown box.
    expect(mounted.container.textContent).not.toContain("[the source](https://example.com/source)");
    expect(mounted.container.textContent).not.toContain("# Findings");
  });

  test("panel shows copy and download actions once content loads", async () => {
    readResourceMock.mockImplementation(async () => ({
      contents: [{ uri: CHIP_PROPS.uri, mimeType: "text/markdown", text: "# Report\n\nBody." }],
    }));

    mounted = await mountSurface();
    await act(async () => {
      findOpenButton(mounted.container).click();
    });
    await settle();

    const labels = Array.from(mounted.container.getElementsByTagName("button")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toContain("Copy document to clipboard");
    expect(labels).toContain("Download document");
    expect(labels).toContain("Close document panel");
  });

  test("fetch failure renders the error state, not a blank panel", async () => {
    readResourceMock.mockImplementation(async () => {
      throw new Error("resource not found");
    });

    mounted = await mountSurface();
    await act(async () => {
      findOpenButton(mounted.container).click();
    });
    await settle();

    expect(mounted.container.textContent).toContain("Failed to load");
    expect(mounted.container.textContent).toContain("resource not found");
  });
});
