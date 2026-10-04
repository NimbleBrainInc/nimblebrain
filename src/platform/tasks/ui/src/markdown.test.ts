/**
 * Sanitization contract for the tasks reader's markdown renderer.
 *
 * `renderMarkdown()` runs LLM output (which may include third-party
 * content fetched by tools) through marked + DOMPurify before injection
 * via `dangerouslySetInnerHTML`. These tests pin the dangerous-tag /
 * dangerous-attr removals so a future config change can't silently
 * weaken the sanitizer.
 *
 * The renderer normally runs in an app iframe (where `window` and
 * `document` exist). Bun's unit test environment doesn't ship a DOM,
 * so we install jsdom globals BEFORE importing the module — both
 * DOMPurify's import-time bootstrap and marked's renderer instantiation
 * need a live `window`. The dynamic import below is the seam that lets
 * the setup run first.
 *
 * jsdom, not happy-dom: a sanitizer test is only as good as its HTML
 * parser, and happy-dom's diverges from the spec enough that DOMPurify
 * both keeps `<script>` and drops allowed tags under it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

let renderMarkdown: (text: string) => string;

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  // Minimum globals DOMPurify needs to construct its hook tree at
  // import time. Loosely typed because jsdom's window type differs
  // from the lib.dom subset Bun ships.
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

  test("strips <iframe>, <object> and <embed>", () => {
    const html = renderMarkdown(
      '<iframe src="evil"></iframe><object data="evil"></object><embed src="evil">OK',
    );
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<object/i);
    expect(html).not.toMatch(/<embed/i);
  });

  test("strips javascript: URLs", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toMatch(/javascript:/i);
  });

  test("preserves safe markdown structure (headings, lists, emphasis, code)", () => {
    const html = renderMarkdown("# Heading\n\n**bold** and *italic*\n\n- one\n- two\n\n`code`");
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
