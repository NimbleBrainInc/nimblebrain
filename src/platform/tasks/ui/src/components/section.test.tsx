/** The section card and the report card: the pieces every page is built from. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Section, SummaryStrip } from "./Section.tsx";

describe("Section", () => {
  test("a card with its title left and its aside right, then its body", () => {
    const html = renderToStaticMarkup(
      <Section title="Result" aside="Show raw">
        body
      </Section>,
    );
    expect(html).toMatch(
      /^<section class="card" aria-labelledby="[^"]+"><div class="card-head"><h2 class="section-heading" id="[^"]+">Result<\/h2><div class="card-aside">Show raw<\/div><\/div><div class="card-body">body<\/div><\/section>$/,
    );
  });
});

describe("SummaryStrip", () => {
  test("every tile has a label and value; one with detail is a button that opens a panel", () => {
    const html = renderToStaticMarkup(
      createElement(SummaryStrip, {
        label: "Run summary",
        tiles: [
          { id: "a", label: "Outcome", value: "Completed", sub: "It finished." },
          { id: "b", label: "Cost", value: "$0.43", detail: "breakdown" },
        ],
      }),
    );
    expect(html).toContain('<ul class="summary-strip" aria-label="Run summary">');
    expect(html).toContain('<div class="tile"><span class="tile-label">Outcome</span>');
    expect(html).toMatch(/<button type="button" class="tile tile-open" aria-expanded="false"/);
    expect(html).not.toContain("breakdown");
  });
});
