// ---------------------------------------------------------------------------
// ArtifactRenderer — sanitizing, curated render registry for UNTRUSTED artifact
// bytes. These tests pin the security contract, not styling:
//
//   - markdown renders WITHOUT executing embedded raw HTML/script (Streamdown
//     sanitizes; a <script> in the source must not become a live <script> node)
//   - text/html renders ONLY inside a script-less sandboxed iframe (empty
//     sandbox, srcDoc) — never injected into the host DOM
//   - an unsupported mime falls back to download and NEVER throws
//   - routing (rendererKindFor) maps mime → renderer deterministically
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ArtifactRenderer, rendererKindFor } = await import("../components/ArtifactRenderer");

function mount(node: React.ReactElement): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = ReactDOMClient.createRoot(host);
  act(() => {
    root.render(node);
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("rendererKindFor — mime → renderer routing", () => {
  test("maps the v1 registry deterministically", () => {
    expect(rendererKindFor("text/markdown")).toBe("markdown");
    expect(rendererKindFor("text/x-markdown")).toBe("markdown");
    expect(rendererKindFor("application/json")).toBe("json");
    expect(rendererKindFor("text/html")).toBe("html");
    expect(rendererKindFor("text/plain")).toBe("text");
  });

  test("strips mime parameters before matching", () => {
    expect(rendererKindFor("text/markdown; charset=utf-8")).toBe("markdown");
  });

  test("unknown or absent mime is unsupported (→ download fallback)", () => {
    expect(rendererKindFor("application/pdf")).toBe("unsupported");
    expect(rendererKindFor("image/png")).toBe("unsupported");
    expect(rendererKindFor(undefined)).toBe("unsupported");
    expect(rendererKindFor("")).toBe("unsupported");
  });
});

describe("ArtifactRenderer — untrusted-render contract", () => {
  test("markdown does NOT execute embedded raw HTML/script", () => {
    const hostile = `# Heading\n\n<script>window.__pwned = true</script>\n\n<img src=x onerror="window.__pwned = true">`;
    const { host, unmount } = mount(
      React.createElement(ArtifactRenderer, { mimeType: "text/markdown", text: hostile }),
    );
    try {
      // No live <script> node injected from the markdown source. (happy-dom's
      // querySelectorAll parser throws on some selectors — traverse by tag.)
      expect(host.getElementsByTagName("script").length).toBe(0);
      // The heading DID render (sanitization, not a blanket escape).
      expect(host.getElementsByTagName("h1")[0]?.textContent).toContain("Heading");
      // The onerror payload never fired.
      expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    } finally {
      unmount();
      delete (globalThis as Record<string, unknown>).__pwned;
    }
  });

  test("html renders only inside a script-less sandboxed iframe", () => {
    const html = `<h1>Doc</h1><script>window.__pwned = true</script>`;
    const { host, unmount } = mount(
      React.createElement(ArtifactRenderer, { mimeType: "text/html", text: html }),
    );
    try {
      const iframe = host.getElementsByTagName("iframe")[0];
      expect(iframe).toBeDefined();
      // Empty sandbox — no allow-scripts, no allow-same-origin. The HTML rides
      // in srcDoc (never the host DOM), so even script markup is inert.
      expect(iframe?.getAttribute("sandbox")).toBe("");
      expect(iframe?.getAttribute("srcdoc")).toContain("<h1>Doc</h1>");
      // The host DOM holds no live script node from the payload.
      expect(host.getElementsByTagName("script").length).toBe(0);
    } finally {
      unmount();
    }
  });

  test("unsupported mime falls back to download and never throws", () => {
    const { host, unmount } = mount(
      React.createElement(ArtifactRenderer, {
        mimeType: "application/pdf",
        text: null,
        objectUrl: "blob:fake",
        downloadName: "report.pdf",
        title: "report.pdf",
      }),
    );
    try {
      const link = Array.from(host.getElementsByTagName("a")).find((a) =>
        a.hasAttribute("download"),
      );
      expect(link).toBeDefined();
      expect(link?.getAttribute("download")).toBe("report.pdf");
      expect(host.textContent).toContain("No preview available");
    } finally {
      unmount();
    }
  });

  test("json renders as normalized data, not executable markup", () => {
    const { host, unmount } = mount(
      React.createElement(ArtifactRenderer, {
        mimeType: "application/json",
        text: '{"b":2,"a":1}',
      }),
    );
    try {
      expect(host.getElementsByTagName("script").length).toBe(0);
      // Pretty-printed (parsed + re-stringified), so a newline appears.
      expect(host.getElementsByTagName("pre")[0]?.textContent).toContain('"b": 2');
    } finally {
      unmount();
    }
  });
});
