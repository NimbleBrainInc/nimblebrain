#!/usr/bin/env bun
/**
 * Lint: `web/index.html` loads nothing from another host.
 *
 * Every resource the page shell names is fetched on every page load, before
 * the app runs, so a third-party URL there sends each visitor's IP address and
 * user agent to that host and breaks a self-hosted install that denies egress.
 * The shell serves its own assets: fonts come from the web build (`fonts.css`),
 * runtime config and brand from the runtime (`/config.js`, `/v1/brand.js`).
 *
 * What this flags: a `src` or `href` attribute whose value is an absolute
 * (`https://…`, `http://…`) or protocol-relative (`//…`) URL, on any tag,
 * outside HTML comments. That covers stylesheets, scripts, preconnect and
 * preload hints, and icons alike.
 *
 * No allow-list and no marker: a resource the shell needs is bundled or served
 * by the runtime.
 *
 * Exports `findExternalUrls` for the self-test under `test/unit/scripts/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const INDEX_HTML = join("web", "index.html");

const ATTR = /\b(src|href)\s*=\s*(["']?)([^"'\s>]*)\2/gi;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

export interface Finding {
  line: number;
  attr: string;
  url: string;
}

/** Blank out HTML comments, keeping newlines so line numbers still hold. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
}

/** Every external `src`/`href` in `html`, in line order. Pure, for the self-test. */
export function findExternalUrls(html: string): Finding[] {
  const findings: Finding[] = [];
  const lines = stripComments(html).split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of (lines[i] ?? "").matchAll(ATTR)) {
      const url = m[3] ?? "";
      if (EXTERNAL.test(url)) {
        findings.push({ line: i + 1, attr: (m[1] ?? "").toLowerCase(), url });
      }
    }
  }
  return findings;
}

function main(): void {
  const findings = findExternalUrls(readFileSync(join(ROOT, INDEX_HTML), "utf-8"));
  if (findings.length > 0) {
    console.error(`✗ ${INDEX_HTML} loads ${findings.length} resource(s) from another host:\n`);
    for (const f of findings) console.error(`  ${INDEX_HTML}:${f.line}  ${f.attr}=${f.url}`);
    console.error("\nBundle the resource into the web build or serve it from the runtime.");
    process.exit(1);
  }
  console.log(`✓ ${INDEX_HTML} loads nothing from another host`);
}

if (import.meta.main) {
  main();
}
