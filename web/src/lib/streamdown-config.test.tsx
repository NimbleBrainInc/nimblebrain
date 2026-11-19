// Images in rendered markdown load from the app's own origin; any other image
// is shown as a link. Renders the shared config through Streamdown, as every
// markdown render site does. happy-dom serves the page at http://localhost.
//
// With link safety on, Streamdown renders a link as a button that opens the
// confirmation for its URL, so a link's target is read by clicking it.

import { describe, expect, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { Streamdown } = await import("streamdown");
const { linkSafety, rehypePlugins } = await import("./streamdown-config");

/** The URL of the last confirmation opened. */
let confirming: string | undefined;
const recordingLinkSafety: typeof linkSafety = {
  ...linkSafety,
  renderModal: (props) => {
    if (props.isOpen) confirming = props.url;
    return null;
  },
};

function render(markdown: string): { host: HTMLDivElement; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = ReactDOMClient.createRoot(host);
  act(() => {
    root.render(
      React.createElement(
        Streamdown,
        { linkSafety: recordingLinkSafety, rehypePlugins, mode: "static" },
        markdown,
      ),
    );
  });
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function imageSources(host: HTMLElement): string[] {
  return Array.from(host.getElementsByTagName("img")).map((img) => img.getAttribute("src") ?? "");
}

function links(host: HTMLElement): Array<{ href: string; text: string }> {
  const buttons = Array.from(host.querySelectorAll('[data-streamdown="link"]'));
  return buttons.map((button) => {
    confirming = undefined;
    act(() => {
      (button as HTMLElement).click();
    });
    return { href: confirming ?? "", text: button.textContent ?? "" };
  });
}

describe("markdown images", () => {
  test("a markdown image from another origin renders as a link, not an image", () => {
    const { host, unmount } = render("![chart](https://images.example.com/chart.png?q=1)");
    try {
      expect(imageSources(host)).toEqual([]);
      expect(links(host)).toContainEqual({
        href: "https://images.example.com/chart.png?q=1",
        text: "chart",
      });
    } finally {
      unmount();
    }
  });

  test("a raw HTML image from another origin renders as a link, not an image", () => {
    const { host, unmount } = render('<img src="https://images.example.com/raw.png" alt="raw">');
    try {
      expect(imageSources(host)).toEqual([]);
      expect(links(host)).toContainEqual({
        href: "https://images.example.com/raw.png",
        text: "raw",
      });
    } finally {
      unmount();
    }
  });

  test("an image with no alt text is labelled with its URL", () => {
    const { host, unmount } = render("![](https://images.example.com/a.png)");
    try {
      expect(imageSources(host)).toEqual([]);
      expect(links(host)).toContainEqual({
        href: "https://images.example.com/a.png",
        text: "https://images.example.com/a.png",
      });
    } finally {
      unmount();
    }
  });

  test("a protocol-relative image never loads from the other host", () => {
    const { host, unmount } = render("![x](//images.example.com/a.png)");
    try {
      for (const src of imageSources(host)) {
        expect(new URL(src, location.href).origin).toBe(location.origin);
      }
    } finally {
      unmount();
    }
  });

  test("a linked image from another origin keeps the outer link and shows its label", () => {
    const { host, unmount } = render(
      "[![badge](https://images.example.com/badge.svg)](https://docs.example.com/)",
    );
    try {
      expect(imageSources(host)).toEqual([]);
      expect(links(host)).toEqual([{ href: "https://docs.example.com/", text: "badge" }]);
    } finally {
      unmount();
    }
  });

  test("picture sources are dropped, and the picture's image is checked", () => {
    const { host, unmount } = render(
      '<picture><source srcset="https://images.example.com/wide.png"><img src="https://images.example.com/narrow.png" alt="p"></picture>',
    );
    try {
      expect(host.getElementsByTagName("source").length).toBe(0);
      expect(imageSources(host)).toEqual([]);
    } finally {
      unmount();
    }
  });

  test("an image on the app's own origin renders inline", () => {
    const { host, unmount } = render(
      "![file](/v1/files/fl_abc)\n\n![abs](http://localhost/v1/files/fl_def)",
    );
    try {
      expect(imageSources(host)).toEqual(["/v1/files/fl_abc", "http://localhost/v1/files/fl_def"]);
    } finally {
      unmount();
    }
  });
});
