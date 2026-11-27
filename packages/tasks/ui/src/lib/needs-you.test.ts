/** Why a run asks for the person, in one sentence, and what "Ask in chat" sends. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRun } from "../types.ts";
import {
  askMessage,
  attentionOf,
  failureSentence,
  failuresOf,
  RUN_REFUSED_TASK_TOOLS,
} from "./needs-you.ts";
import { outcomeOf } from "./outcome.ts";

const run = (label: string, extra: Partial<TaskRun> = {}): TaskRun => ({
  id: "run_1",
  taskId: "digest",
  execution: "completed",
  label,
  ...extra,
});

describe("failureSentence, one plain sentence per run", () => {
  test("the case that started it: a run that tried to author scheduled tasks", () => {
    expect(
      failureSentence([
        { name: "tasks__create", errorReason: "denied" },
        { name: "tasks__cancel", errorReason: "denied" },
      ]),
    ).toBe("This task tried to create and cancel scheduled tasks, which scheduled runs can't do.");
  });

  test.each([
    [
      "denied, another tool",
      [{ name: "skills__create", errorReason: "denied" }],
      undefined,
      "This task tried to use Create in skills, which isn't allowed in scheduled runs.",
    ],
    [
      "denied, outside the task's allowedTools",
      [{ name: "gmail__send_message", errorReason: "denied" }],
      ["files__*"],
      "This task isn't allowed to use Send message in gmail.",
    ],
    [
      "unavailable",
      [
        { name: "gmail__send", errorReason: "unavailable" },
        { name: "gmail__read", errorReason: "unavailable" },
      ],
      undefined,
      "This task couldn't reach gmail, which isn't connected.",
    ],
    [
      "bad_input",
      [{ name: "hubspot__search_deals", errorReason: "bad_input" }],
      undefined,
      "This task called Search deals in hubspot with arguments it rejected.",
    ],
    [
      "tool_error",
      [{ name: "hubspot__search_deals", errorReason: "tool_error" }],
      undefined,
      "This task got an error back from Search deals in hubspot.",
    ],
    [
      "timeout",
      [{ name: "web__fetch", errorReason: "timeout" }],
      undefined,
      "This task timed out waiting on Fetch in web.",
    ],
    ["no reason", [{ name: "web__fetch" }], undefined, "This task had Fetch in web fail."],
  ])("%s", (_case, failures, allowedTools, expected) => {
    expect(failureSentence(failures, allowedTools)).toBe(expected);
  });

  test("groups by reason in the order they first failed, in one sentence", () => {
    expect(
      failureSentence([
        { name: "tasks__run", errorReason: "denied" },
        { name: "hubspot__search", errorReason: "tool_error" },
        { name: "tasks__run_batch", errorReason: "denied" },
        { name: "slack__post", errorReason: "tool_error" },
      ]),
    ).toBe(
      "This task tried to run scheduled tasks, which scheduled runs can't do, and got an error back from Search in hubspot and Post in slack.",
    );
  });

  test("nothing failed: no sentence", () => {
    expect(failureSentence([])).toBeNull();
  });
});

describe("failuresOf", () => {
  test("the record's reasons first, then the activity log's last failed call, then names", () => {
    const named = run("Needs review", { unrecoveredToolFailures: ["a__x"] });
    expect(
      failuresOf({ ...named, toolFailures: [{ name: "a__x", errorReason: "timeout" }] }),
    ).toEqual([{ name: "a__x", errorReason: "timeout" }]);
    expect(
      failuresOf(named, [
        { name: "a__x", ok: false, errorReason: "timeout" },
        { name: "a__x", ok: false, errorReason: "denied" },
      ]),
    ).toEqual([{ name: "a__x", errorReason: "denied" }]);
    expect(failuresOf(named)).toEqual([{ name: "a__x" }]);
  });
});

describe("attentionOf", () => {
  test("Needs review from tool failures, from a limit, or nothing to say", () => {
    expect(
      attentionOf(
        run("Needs review", { toolFailures: [{ name: "tasks__update", errorReason: "denied" }] }),
      ),
    ).toBe("This task tried to edit scheduled tasks, which scheduled runs can't do.");
    expect(
      attentionOf(run("Needs review", { execution: "incomplete" }), {
        stopReason: "max_iterations",
      }),
    ).toBe(
      "This task reached its step limit before it finished, so part of its work may be undone.",
    );
    expect(
      attentionOf(
        run("Needs review", {
          error: "Told to wrap up at its max_input_tokens limit; part of its work may be undone",
        }),
      ),
    ).toBe(
      "This task reached its input-token limit before it finished, so part of its work may be undone.",
    );
    expect(attentionOf(run("Needs review"))).toBeNull();
  });
  test("a poor result says its output missed its shape; a failure only with tool failures", () => {
    expect(attentionOf(run("Poor result"))).toBe(outcomeOf("Poor result").reason ?? "");
    expect(
      attentionOf(
        run("Failed", { toolFailures: [{ name: "gmail__send", errorReason: "unavailable" }] }),
      ),
    ).toBe("This task couldn't reach gmail, which isn't connected.");
    expect(attentionOf(run("Failed"))).toBeNull();
    expect(attentionOf(run("Succeeded"))).toBeNull();
  });
});

describe("askMessage", () => {
  test("carries the task, the run and the failure, and asks for the fix", () => {
    const text = askMessage({ id: "digest", name: "Digest" }, { id: "run_1" }, "This task X.");
    expect(text).toContain('"Digest" (id digest)');
    expect(text).toContain("run run_1 says: This task X.");
    expect(text).toContain("tasks__update");
  });
});

test("the refused tasks tools are the contract's", () => {
  const doc = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../schemas/contracts/tasks/v1/contract.json"),
      "utf-8",
    ),
  ) as { tools: Record<string, { visibility: string; unattended: string }> };
  const refused = Object.entries(doc.tools)
    .filter(([, t]) => t.visibility === "public" && t.unattended === "refused")
    .map(([name]) => `tasks__${name}`);
  expect(Object.keys(RUN_REFUSED_TASK_TOOLS).sort()).toEqual(refused.sort());
});

describe("outcomeOf, the one label-to-word mapping", () => {
  test.each([
    ["Succeeded", "Done"],
    ["Needs review", "Needs you"],
    ["Poor result", "Didn't work"],
    ["Failed", "Didn't work"],
    ["Skipped", "Didn't run"],
    ["Cancelled", "Stopped"],
    ["Queued", "Waiting"],
    ["Running", "Running"],
    ["Something new", "Something new"],
  ])("%s reads %s", (label, word) => {
    expect(outcomeOf(label).word).toBe(word);
  });
});
