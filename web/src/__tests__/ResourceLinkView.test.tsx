// ---------------------------------------------------------------------------
// ResourceLinkView — binary-resource render contract
//
// Pins the rule that determines which HTML primitive renders each MIME type
// returned by an MCP resource_link, and — load-bearing for the Arc /
// Chromium opaque-origin bug — that the PDF iframe carries NO `sandbox`
// attribute.
//
// Why this matters: a `sandbox` without `allow-same-origin` makes the
// iframe an opaque origin, and Chromium then refuses to navigate to a
// parent-owned `blob:` URL. Arc surfaces the refusal as "This page has
// been blocked by Arc" and the PDF preview never loads. A previous version
// of this file added `sandbox="allow-scripts"` thinking it tightened
// defense against malicious PDFs; in practice it broke PDF preview for
// every Chromium-based browser. PDFs are routed to PDFium in a separate
// sandboxed renderer process — the iframe `sandbox` attribute does not
// add isolation for them and the browser's process model already provides
// what we need. This test is the regression guard so a future contributor
// can't silently re-add it.
//
// Implementation: rendering goes through `react-dom/client` directly,
// without `@testing-library/react`. happy-dom's selector parser throws on
// some inputs testing-library produces; getElementsByTagName sidesteps
// that, and the contract we need to pin is simple enough not to need the
// fuller library.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

// Tell React 19 we're inside an act-aware test environment. Without this
// flag, every awaited setState inside an async useEffect logs a warning
// (the rendered output is still correct, the noise is just ugly).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const readResourceMock = mock(
  async (_server: string, _uri: string): Promise<{ contents: unknown[] }> => ({ contents: [] }),
);

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only `readResource` is
// overridden. The snapshot also carries the real `ApiClientError` constructor
// that ResourceLinkView's catch branch (`err instanceof ApiClientError`) needs.
mock.module("../api/client", () => ({
  ...realClient,
  readResource: readResourceMock,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { ResourceLinkView } = await import("../components/ResourceLinkView");
const { act } = await import("react");

beforeEach(() => {
  readResourceMock.mockReset();
  // happy-dom: createObjectURL / revokeObjectURL exist but produce ad-hoc
  // strings. Stabilise the value so assertions on `src` are deterministic.
  let counter = 0;
  (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = (() => {
    counter += 1;
    return `blob:http://localhost/fake-${counter}`;
  }) as typeof URL.createObjectURL;
  (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = (() => {
    /* noop */
  }) as typeof URL.revokeObjectURL;
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

async function mount(props: Parameters<typeof ResourceLinkView>[0]): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(ResourceLinkView, props));
  });
  // Allow the post-render useEffect's awaited readResource() to settle and
  // the resulting setState to commit a second render.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

const FAKE_BYTES_B64 = "JVBERi0xLjQK"; // "%PDF-1.4\n"

describe("ResourceLinkView — PDF rendering", () => {
  test("PDF result renders an iframe with NO sandbox attribute", async () => {
    readResourceMock.mockImplementation(async () => ({
      contents: [
        {
          uri: "collateral://exports/exp_test.pdf",
          mimeType: "application/pdf",
          blob: FAKE_BYTES_B64,
        },
      ],
    }));

    mounted = await mount({
      appName: "collateral",
      uri: "collateral://exports/exp_test.pdf",
      name: "Export of Test Doc",
      mimeType: "application/pdf",
    });

    const iframe = mounted.container.getElementsByTagName("iframe")[0];
    if (!iframe) {
      throw new Error(
        `iframe not rendered. readResource calls=${readResourceMock.mock.calls.length}, html=${mounted.container.innerHTML.slice(0, 400)}`,
      );
    }

    // Load-bearing: no `sandbox` attribute. Re-adding it (even just
    // `allow-scripts`) breaks PDF preview in Arc / Chromium because blob:
    // URLs cannot be navigated to from an opaque-origin iframe. PDFium
    // already provides process-level isolation for the PDF viewer.
    expect(iframe.hasAttribute("sandbox")).toBe(false);

    // Sanity: it's the blob URL we minted, so the wiring still works.
    expect(iframe.getAttribute("src")).toMatch(/^blob:/);
  });
});

describe("ResourceLinkView — non-PDF binary fallback", () => {
  test("unknown binary MIME falls through to a download link, no iframe", async () => {
    readResourceMock.mockImplementation(async () => ({
      contents: [
        {
          uri: "app://misc/blob.bin",
          mimeType: "application/octet-stream",
          blob: FAKE_BYTES_B64,
        },
      ],
    }));

    mounted = await mount({
      appName: "misc",
      uri: "app://misc/blob.bin",
      mimeType: "application/octet-stream",
    });

    const anchor = Array.from(mounted.container.getElementsByTagName("a")).find((a) =>
      a.hasAttribute("download"),
    );
    if (!anchor) {
      throw new Error(`download anchor missing. html=${mounted.container.innerHTML.slice(0, 400)}`);
    }
    expect(mounted.container.getElementsByTagName("iframe").length).toBe(0);
    expect(anchor.getAttribute("href")).toMatch(/^blob:/);
  });
});

describe("ResourceLinkView — image rendering", () => {
  test("image/* result renders an <img>, never an iframe", async () => {
    readResourceMock.mockImplementation(async () => ({
      contents: [
        {
          uri: "app://render/preview.png",
          mimeType: "image/png",
          blob: FAKE_BYTES_B64,
        },
      ],
    }));

    mounted = await mount({
      appName: "render",
      uri: "app://render/preview.png",
      mimeType: "image/png",
    });

    const img = mounted.container.getElementsByTagName("img")[0];
    if (!img) {
      throw new Error(`img not rendered. html=${mounted.container.innerHTML.slice(0, 400)}`);
    }
    expect(mounted.container.getElementsByTagName("iframe").length).toBe(0);
    expect(img.getAttribute("src")).toMatch(/^blob:/);
  });
});
