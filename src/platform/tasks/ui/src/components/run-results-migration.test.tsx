/**
 * One-off (ephemeral branch): a run given a result by
 * `scripts/ephemeral/run-results.ts` reads in the Tasks panel as its preview
 * fallback did.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resultOfLine } from "../../../../../../scripts/ephemeral/run-results.ts";
import type { TaskRun } from "../types.ts";

let result: typeof import("./ResultView.tsx");

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  const g = globalThis as any;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.Node = window.Node;
  result = await import("./ResultView.tsx");
});

const NOTICE = '<p class="muted">Showing the preview; the full result could not be read.</p>';

describe("a migrated run", () => {
  const runs: TaskRun[] = [
    {
      id: "run_a",
      taskId: "digest",
      status: "success",
      execution: "completed",
      startedAt: "2026-06-01T00:00:00Z",
      completedAt: "2026-06-01T00:01:00Z",
      resultPreview: "## Three prospects\n\n- Acme",
    },
    {
      id: "run_b",
      taskId: "digest",
      status: "timeout",
      execution: "incomplete",
      startedAt: "2026-06-01T00:00:00Z",
      completedAt: "2026-06-01T00:01:00Z",
      error: "timed out",
      resultPreview: '{"company":"Acme"',
    },
    {
      id: "run_c",
      taskId: "digest",
      status: "failure",
      execution: "failed",
      startedAt: "2026-06-01T00:00:00Z",
      completedAt: "2026-06-01T00:01:00Z",
      error: "boom",
    },
  ];

  for (const run of runs) {
    test(`${run.id} shows what the preview fallback showed`, () => {
      const fallback = renderToStaticMarkup(
        createElement(result.Deliverable, { result: null, run }),
      ).replace(NOTICE, "");
      // The script reads the stored line, which the UI type mirrors.
      // biome-ignore lint/suspicious/noExplicitAny: stored-line shape, test only
      const migrated = resultOfLine(run.taskId, run as any);
      const read = renderToStaticMarkup(
        createElement(result.Deliverable, { result: migrated, run }),
      );
      expect(read).toBe(fallback);
    });
  }
});
