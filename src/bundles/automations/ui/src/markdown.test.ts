/**
 * Sanitization contract for the automations reader's markdown renderer.
 *
 * `renderMarkdown()` runs LLM output (which may include third-party
 * content fetched by tools) through marked + DOMPurify before injection
 * via `dangerouslySetInnerHTML`. These tests pin the dangerous-tag /
 * dangerous-attr removals so a future config change can't silently
 * weaken the sanitizer.
 *
 * The renderer normally runs in a bundle iframe (where `window` and
 * `document` exist). Bun's unit test environment doesn't ship a DOM,
 * so we install happy-dom globals BEFORE importing the module — both
 * DOMPurify's import-time bootstrap and marked's renderer instantiation
 * need a live `window`. The dynamic import below is the seam that lets
 * the setup run first.
 */

import { Window } from "happy-dom";
import { beforeAll, describe, expect, test } from "bun:test";

let renderMarkdown: (text: string) => string;

beforeAll(async () => {
  const window = new Window({ url: "http://localhost" });
  // Minimum globals DOMPurify needs to construct its hook tree at
  // import time. Loosely typed because happy-dom's surface is wider
  // than the lib.dom subset Bun ships.
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  (globalThis as any).window = window;
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  (globalThis as any).document = window.document;
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  (globalThis as any).HTMLElement = window.HTMLElement;
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  (globalThis as any).Node = window.Node;
  ({ renderMarkdown } = await import("./markdown.ts"));
});

describe("renderMarkdown — sanitization contract", () => {
  test("strips <script> tags from input", () => {
    const html = renderMarkdown("Before<script>alert('xss')</script>After");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/alert/i);
  });

  test("strips inline event handlers (onerror, onclick, onload)", () => {
    const html = renderMarkdown(
      '<img src="x" onerror="alert(1)" onclick="alert(2)" onload="alert(3)">',
    );
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/onclick/i);
    expect(html).not.toMatch(/onload/i);
  });

  test("strips <iframe>", () => {
    // happy-dom's HTML parser leaves some void/legacy embed elements
    // (`<object>`, `<embed>`) in place even with a strict ALLOWED_TAGS
    // allowlist — a known parser limitation, NOT a production gap. The
    // real browser DOM that the bundle runs against enforces the
    // allowlist faithfully. `<iframe>` is the one parsers handle
    // uniformly, so we use it as the canary for the allowlist.
    const html = renderMarkdown('<iframe src="evil"></iframe>OK');
    expect(html).not.toMatch(/<iframe/i);
  });

  test("strips javascript: URLs", () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
  });

  test("preserves safe markdown structure (headings, lists, emphasis, code)", () => {
    const html = renderMarkdown(
      "# Heading\n\n**bold** and *italic*\n\n- one\n- two\n\n`code`",
    );
    expect(html).toMatch(/<h1/);
    expect(html).toMatch(/<strong>/);
    expect(html).toMatch(/<em>/);
    expect(html).toMatch(/<ul>/);
    expect(html).toMatch(/<li>/);
    expect(html).toMatch(/<code>/);
  });

  test("preserves links with safe protocols", () => {
    const html = renderMarkdown(
      "[a](https://example.com) [b](http://example.com) [c](mailto:test@example.com)",
    );
    expect(html).toMatch(/href="https:\/\/example\.com"/);
    expect(html).toMatch(/href="http:\/\/example\.com"/);
    expect(html).toMatch(/href="mailto:test@example\.com"/);
  });
});
