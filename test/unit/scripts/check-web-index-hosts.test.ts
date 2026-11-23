/**
 * Self-tests for `scripts/check-web-index-hosts.ts`.
 *
 * Exercises the exported `findExternalUrls` directly on in-memory HTML.
 */

import { describe, expect, test } from "bun:test";
import { findExternalUrls } from "../../../scripts/check-web-index-hosts.ts";

function urls(html: string): string[] {
  return findExternalUrls(html).map((f) => f.url);
}

describe("check-web-index-hosts", () => {
  test("flags an external stylesheet and its preconnect", () => {
    const html = [
      '<link rel="preconnect" href="https://fonts.example.com" crossorigin>',
      '<link href="https://cdn.example.com/css?family=X" rel="stylesheet">',
    ].join("\n");
    expect(urls(html)).toEqual([
      "https://fonts.example.com",
      "https://cdn.example.com/css?family=X",
    ]);
  });

  test("flags an external script, any scheme, and protocol-relative URLs", () => {
    const html = [
      "<script src='http://cdn.example.com/a.js'></script>",
      '<script src="//cdn.example.com/b.js"></script>',
      "<link rel=icon href=HTTPS://cdn.example.com/i.png>",
    ].join("\n");
    expect(urls(html)).toEqual([
      "http://cdn.example.com/a.js",
      "//cdn.example.com/b.js",
      "HTTPS://cdn.example.com/i.png",
    ]);
  });

  test("reports the line and attribute", () => {
    expect(findExternalUrls('<head>\n  <script src="https://x.example.com/a.js">')).toEqual([
      { line: 2, attr: "src", url: "https://x.example.com/a.js" },
    ]);
  });

  test("allows same-origin paths", () => {
    const html = [
      '<link rel="icon" href="/favicon.ico">',
      '<script src="/config.js"></script>',
      '<script type="module" src="/src/main.tsx"></script>',
      '<link href="./local.css" rel="stylesheet">',
    ].join("\n");
    expect(urls(html)).toEqual([]);
  });

  test("ignores URLs inside HTML comments, keeping later line numbers", () => {
    const html =
      '<!-- see\n<script src="https://x.example.com/a.js"> -->\n<script src="https://y.example.com/b.js">';
    expect(findExternalUrls(html)).toEqual([
      { line: 3, attr: "src", url: "https://y.example.com/b.js" },
    ]);
  });
});
