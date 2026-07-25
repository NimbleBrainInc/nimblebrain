/**
 * Every markdown table in the docs site must have the same number of cells in
 * each body row as in its header.
 *
 * This is the one docs defect the site's own CI cannot see. `docs-ci.yml`
 * validates links, and Astro renders a malformed table without complaint:
 * GFM silently drops cells past the header count and pads missing ones with
 * empty `<td>`s. So a row that loses a cell doesn't fail a build or 404 — it
 * publishes to docs.nimblebrain.ai with its remaining text shifted one column
 * left, filed under the wrong heading. A reader is told the fix is the cause.
 *
 * That happened three times in a row while editing these tables with regexes,
 * because the source still *looks* like a table and the render only misleads
 * rather than breaking. Reviewing the diff catches it only if you count cells;
 * this counts them.
 *
 * Note the invariant is cell COUNT, not cell content. An empty cell is a
 * legitimate way to write an asymmetric comparison (see `using/workspaces`,
 * where the left column lists more items than the right), so blankness alone
 * proves nothing — mismatch does.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DOCS = join(import.meta.dir, "..", "..", "..", "docs", "src", "content", "docs");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return /\.mdx?$/.test(entry) ? [path] : [];
  });
}

/**
 * Split a table row into cells the way GFM does: on every `|` that is not
 * backslash-escaped, with one optional leading and trailing pipe stripped
 * first. GFM splits inside code spans too, so backticks get no special
 * treatment here — matching the renderer matters more than matching intuition.
 */
function splitCells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      cell += inner.slice(i, i + 2);
      i++;
    } else if (inner[i] === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += inner[i];
    }
  }
  cells.push(cell);
  return cells;
}

const isDelimiter = (line: string) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?$/.test(line.trim());

type BadRow = { file: string; line: number; want: number; got: number; text: string };

/** Every body row whose cell count differs from its header's. */
function malformedRows(path: string, source: string): BadRow[] {
  const lines = source.split("\n");
  const bad: BadRow[] = [];
  let fenced = false;
  let want = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    // A row is any non-blank line containing an unescaped pipe. Requiring a
    // leading `|` would agree with how these docs happen to be written and
    // disagree with GFM — and with `splitCells` below, which strips the outer
    // pipes precisely because they are optional. A table written without them
    // would then be invisible to this guard rather than checked by it.
    const isRow = /(^|[^\\])\|/.test(line) && line.trim() !== "";
    if (!isRow) {
      want = 0;
      continue;
    }
    if (isDelimiter(line)) continue;
    // A row directly above a delimiter is the header — it defines the width.
    if (isDelimiter(lines[i + 1] ?? "")) {
      want = splitCells(line).length;
      continue;
    }
    if (want === 0) continue; // a pipe line outside any table

    const got = splitCells(line).length;
    if (got !== want) {
      bad.push({ file: path.slice(DOCS.length + 1), line: i + 1, want, got, text: line.trim() });
    }
  }
  return bad;
}

describe("docs markdown tables", () => {
  const files = markdownFiles(DOCS);

  test("the docs tree is actually being scanned", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("a table written without outer pipes is checked, not skipped", () => {
    const source = ["a | b", "--|--", "c | d", "e | f | g", ""].join("\n");
    expect(malformedRows(join(DOCS, "x.md"), source).map((b) => [b.want, b.got])).toEqual([[2, 3]]);
  });

  test("a fenced code block containing pipes is ignored", () => {
    const source = ["```", "| a | b |", "|---|---|", "| c |", "```", ""].join("\n");
    expect(malformedRows(join(DOCS, "x.md"), source)).toEqual([]);
  });

  test("every table row has as many cells as its header", () => {
    const bad = files.flatMap((f) => malformedRows(f, readFileSync(f, "utf8")));
    const report = bad
      .map((b) => `${b.file}:${b.line} — header has ${b.want} cells, row has ${b.got}\n    ${b.text}`)
      .join("\n");
    expect(report).toBe("");
  });
});

describe("splitCells matches GFM", () => {
  test("strips the optional outer pipes", () => {
    expect(splitCells("| a | b |")).toHaveLength(2);
    expect(splitCells("a | b")).toHaveLength(2);
  });

  test("counts an empty cell", () => {
    expect(splitCells("| a | |")).toHaveLength(2);
  });

  test("an escaped pipe stays inside its cell", () => {
    expect(splitCells("| a \\| b | c |")).toHaveLength(2);
  });

  test("a pipe in a code span still splits, as GFM specifies", () => {
    expect(splitCells("| `a | b` | c |")).toHaveLength(3);
  });
});
