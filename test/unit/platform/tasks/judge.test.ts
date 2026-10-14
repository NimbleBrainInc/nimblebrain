import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  assessRun,
  findJudgeServer,
  type JudgeDispatchResult,
  type JudgePort,
  type JudgeSourceView,
  judgeWarnings,
} from "../../../../src/platform/tasks/judge.ts";
import type { Task, TaskRun, TaskRunResult } from "../../../../src/platform/tasks/types.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { splitInnerToolName } from "../../../../src/util/tool-name.ts";
import { answerAll, createStubJudge, type StubJudge } from "../../../helpers/stub-judge.ts";

const WS = "ws_0076759dbbe19fcc";
const OWNER = "usr_test";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "research",
    name: "Research",
    prompt: "Research the company.",
    enabled: true,
    source: "user",
    ownerId: OWNER,
    workspaceId: WS,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    criteria: [
      { id: "sourced", rule: "Every claim cites a source.", type: "boolean" },
      { id: "short", rule: "At most two prospects.", type: "boolean" },
    ],
    ...overrides,
  };
}

const run: TaskRun = {
  id: "run_abcdefabcdef",
  taskId: "research",
  startedAt: "2026-10-01T00:00:00.000Z",
  completedAt: "2026-10-01T00:01:00.000Z",
  status: "success",
  inputTokens: 10,
  outputTokens: 10,
  toolCalls: 1,
  iterations: 1,
  stopReason: "complete",
  resultPreview: "A report",
  input: { company: "acme-corp" },
};

const result: TaskRunResult = {
  runId: run.id,
  taskId: "research",
  completedAt: "2026-10-01T00:01:00.000Z",
  output: "A report",
  activityLog: [
    { id: "tc1", name: "web__fetch", input: { url: "x" }, output: "ok", ok: true, ms: 1 },
  ],
  outputFiles: [],
  usage: { inputTokens: 10, outputTokens: 10, iterations: 1 },
};

/**
 * A port over in-process sources: discovery lists their tools, and a call
 * executes the named tool on the named source, mapped to the dispatch door's
 * outcomes the way the door maps a tool's result.
 */
function portOver(sources: McpSource[], override?: Partial<JudgePort>): JudgePort {
  return {
    sources: async () =>
      Promise.all(
        sources.map(async (s) => ({
          name: s.name,
          toolNames: (await s.tools()).map((t) => splitInnerToolName(t.name).bareToolName),
        })),
      ),
    call: async ({ tool, input }): Promise<JudgeDispatchResult> => {
      const { sourcePrefix, bareToolName } = splitInnerToolName(tool);
      const source = sources.find((s) => s.name === sourcePrefix);
      if (!source) return { outcome: "error", classification: "unknown_tool_source" };
      const res = await source.execute(bareToolName, input);
      return res.isError
        ? { outcome: "error", classification: "tool_error", result: res }
        : { outcome: "ok", result: res };
    },
    ...override,
  };
}

let stub: StubJudge;
const noSleep = async () => {};

beforeEach(async () => {
  stub = await createStubJudge("judge");
});
afterEach(async () => {
  await stub.source.stop();
});

describe("findJudgeServer: the runtime names no judge", () => {
  const judge = (name: string): JudgeSourceView => ({ name, toolNames: ["judge", "list_judges"] });
  const other = (name: string): JudgeSourceView => ({ name, toolNames: ["search", "judge"] });

  it("none connected: not assessed, saying to connect one", () => {
    expect(findJudgeServer([other("crm")], undefined)).toEqual({
      code: "no_judge",
      reason: expect.stringContaining("connect one"),
    });
  });
  it("exactly one connected: that one", () => {
    expect(findJudgeServer([other("crm"), judge("grader")], undefined)).toEqual({
      server: "grader",
    });
  });
  it("more than one connected: refuses to guess", () => {
    const found = findJudgeServer([judge("a"), judge("b")], undefined);
    expect(found).toEqual({
      code: "judge_ambiguous",
      reason: expect.stringContaining("more than one judge server"),
    });
    expect(found).toMatchObject({ reason: expect.stringContaining("name one") });
  });
  it("named: that one, even among several", () => {
    expect(findJudgeServer([judge("a"), judge("b")], "b")).toEqual({ server: "b" });
  });
  it("named but not a judge server, or not connected", () => {
    expect(findJudgeServer([other("crm")], "crm")).toEqual({
      code: "judge_not_found",
      reason: expect.stringContaining("not a judge server"),
    });
    expect(findJudgeServer([judge("a")], "b")).toEqual({
      code: "judge_not_found",
      reason: expect.stringContaining("not connected"),
    });
  });
});

describe("assessRun", () => {
  it("passes when every criterion passes with enough confidence, recording the judge", async () => {
    const a = await assessRun(task(), run, result, { port: portOver([stub.source]) });
    expect(a.verdict).toBe("pass");
    expect(a.judge).toEqual({
      server: "judge",
      id: "stub",
      version: "stub-1.0.0",
      calibrated: true,
    });
    expect(a.criteria?.map((c) => c.passed)).toEqual([true, true]);
    expect(a.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
    // One call, with the contract's shape.
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call?.criteria.map((c) => c.id)).toEqual(["sourced", "short"]);
    expect(call?.state.input).toEqual({ company: "acme-corp" });
    expect(call?.state.deliverable).toBe("A report");
    expect(call?.state.activity).toEqual([{ tool: "web__fetch", ok: true, input: '{"url":"x"}' }]);
    expect(call?.judge).toBeUndefined();
  });

  it("fails when a criterion fails", async () => {
    stub.answer = (c) => {
      const out = answerAll(c, true);
      if (out.answers[1]) out.answers[1].answer = false;
      return out;
    };
    const a = await assessRun(task(), run, result, { port: portOver([stub.source]) });
    expect(a.verdict).toBe("fail");
    expect(a.criteria?.find((c) => c.id === "short")?.passed).toBe(false);
  });

  it("is uncertain below the threshold, and the task's threshold decides", async () => {
    stub.answer = (c) => answerAll(c, true, 0.65);
    expect((await assessRun(task(), run, result, { port: portOver([stub.source]) })).verdict).toBe(
      "uncertain",
    );
    const lenient = task({ confidenceThreshold: 0.6 });
    expect((await assessRun(lenient, run, result, { port: portOver([stub.source]) })).verdict).toBe(
      "pass",
    );
  });

  it("decides a score by its probabilities, and a choice by its pass options", async () => {
    const t = task({
      criteria: [
        { id: "fit", rule: "Fit?", type: "score", levels: ["no", "weak", "ok", "strong"], pass: 2 },
        { id: "tone", rule: "Tone?", type: "choice", options: ["formal", "rude"], pass: "formal" },
      ],
    });
    stub.answer = () => ({
      judge: { id: "stub", calibrated: true },
      answers: [
        {
          id: "fit",
          answer: 1,
          probabilities: { "0": 0, "1": 0.45, "2": 0.35, "3": 0.2 },
          confidence: 0.9,
        },
        { id: "tone", answer: "formal", confidence: 0.9 },
      ],
    });
    const a = await assessRun(t, run, result, { port: portOver([stub.source]) });
    expect(a.verdict).toBe("pass");
    expect(stub.calls[0]?.criteria[0]).toMatchObject({
      levels: ["no", "weak", "ok", "strong"],
      pass: 2,
    });
  });

  it("an invalid output schema fails without calling the judge", async () => {
    const t = task({ outputSchema: { type: "object" } });
    const invalid = { ...run, outputSchemaValid: false, outputSchemaErrors: ["not JSON"] };
    const a = await assessRun(t, invalid, result, { port: portOver([stub.source]) });
    expect(a.verdict).toBe("fail");
    expect(a.schema).toEqual({ valid: false, errors: ["not JSON"] });
    expect(stub.calls).toHaveLength(0);
  });

  it("a valid schema with no criteria passes without a judge", async () => {
    const t = task({ outputSchema: { type: "object" }, criteria: undefined });
    const a = await assessRun(t, { ...run, outputSchemaValid: true }, result, {
      port: portOver([]),
    });
    expect(a).toMatchObject({ verdict: "pass", schema: { valid: true } });
  });

  it("no schema and no criteria is not assessed", async () => {
    const a = await assessRun(task({ criteria: undefined }), run, result, { port: portOver([]) });
    expect(a.verdict).toBe("not_assessed");
    expect(a.reason?.code).toBe("nothing_to_check");
    expect(a.reason?.message).toContain("no output schema and no criteria");
  });

  it("with no judge connected, criteria are uncertain (never a pass) and nothing is called", async () => {
    const a = await assessRun(task(), run, result, { port: portOver([]) });
    expect(a.verdict).toBe("uncertain");
    expect(a.criteria).toBeUndefined();
    expect(a.reason?.code).toBe("no_judge");
    expect(a.reason?.message).toContain("connect one");
  });

  it("forwards the task's judge id and options", async () => {
    const t = task({ judge: { id: "stub", options: { model: "stub-2" } } });
    await assessRun(t, run, result, { port: portOver([stub.source]) });
    expect(stub.calls[0]?.judge).toEqual({ id: "stub", options: { model: "stub-2" } });
  });

  it("retries a retryable error with backoff, then records the answer", async () => {
    let n = 0;
    stub.answer = (c) => (++n <= 2 ? { error: "rate_limited" } : answerAll(c, true));
    const slept: number[] = [];
    const a = await assessRun(task(), run, result, {
      port: portOver([stub.source]),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(a.verdict).toBe("pass");
    expect(stub.calls).toHaveLength(3);
    expect(slept).toEqual([2_000, 8_000]);
  });

  it("a retryable error that persists is uncertain after the bounded retries", async () => {
    stub.answer = () => ({ error: "upstream_unavailable" });
    const a = await assessRun(task(), run, result, {
      port: portOver([stub.source]),
      sleep: noSleep,
    });
    expect(a.verdict).toBe("uncertain");
    expect(a.reason).toEqual({
      code: "judge_unavailable",
      message: "the judge was unavailable (upstream_unavailable) after 4 attempts",
    });
    expect(stub.calls).toHaveLength(4);
  });

  it("the dispatch door's timeout counts as upstream_timeout and is retried", async () => {
    let n = 0;
    const port = portOver([stub.source]);
    const timingOut: JudgePort = {
      ...port,
      call: async (opts) =>
        ++n === 1 ? { outcome: "error", classification: "timeout" } : port.call(opts),
    };
    const a = await assessRun(task(), run, result, { port: timingOut, sleep: noSleep });
    expect(a.verdict).toBe("pass");
    expect(n).toBe(2);
  });

  for (const code of ["bad_input", "upstream_rejected", "auth_required", "internal"]) {
    it(`${code} is uncertain at once, with the classified reason`, async () => {
      stub.answer = () => ({ error: code });
      const a = await assessRun(task(), run, result, {
        port: portOver([stub.source]),
        sleep: noSleep,
      });
      expect(a.verdict).toBe("uncertain");
      expect(a.reason).toEqual({ code: "judge_error", message: `the judge answered ${code}` });
      expect(stub.calls).toHaveLength(1);
    });
  }

  it("a refused or skipped call is uncertain with why", async () => {
    const denied = portOver([stub.source], {
      call: async () => ({ outcome: "denied", classification: "tool_permission_denied" }),
    });
    expect((await assessRun(task(), run, result, { port: denied })).reason?.message).toContain(
      "tool_permission_denied",
    );
    const skipped = portOver([stub.source], {
      call: async () => ({ outcome: "skipped", classification: "owner_not_member" }),
    });
    expect((await assessRun(task(), run, result, { port: skipped })).reason?.message).toContain(
      "not a member",
    );
  });

  it("an answer the runtime cannot read is uncertain rather than guessed", async () => {
    stub.answer = () => ({ malformed: { verdict: "looks good" } });
    const a = await assessRun(task(), run, result, { port: portOver([stub.source]) });
    expect(a).toMatchObject({ verdict: "uncertain", reason: { code: "judge_unreadable" } });
    expect(a.reason?.message).toContain("could not read");

    stub.answer = (c) => answerAll(c, "maybe");
    const b = await assessRun(task(), run, result, { port: portOver([stub.source]) });
    expect(b.verdict).toBe("uncertain");
    expect(b.reason?.message).toContain("does not fit its type");
  });

  it("marks a capped state", async () => {
    const long = { ...result, output: "x".repeat(100_000) };
    const a = await assessRun(task(), run, long, { port: portOver([stub.source]) });
    expect(a.stateTruncated).toBe(true);
    expect(String(stub.calls[0]?.state.deliverable)).toContain("…[truncated:");
  });

  it("a port that throws is uncertain, never a throw", async () => {
    const broken = portOver([], {
      sources: async () => {
        throw new Error("registry gone");
      },
    });
    const a = await assessRun(task(), run, result, { port: broken });
    expect(a.verdict).toBe("uncertain");
  });

  it("a source that cannot list its tools is named in the reason", async () => {
    const unlisted = portOver([], {
      sources: async () => [{ name: "flaky", toolNames: [], unlisted: true }],
    });
    const a = await assessRun(task(), run, result, { port: unlisted });
    expect(a.reason?.code).toBe("no_judge");
    expect(a.reason?.message).toContain("flaky could not list its tools");
    const named = await assessRun(task({ judge: { server: "flaky" } }), run, result, {
      port: unlisted,
    });
    expect(named.reason?.code).toBe("judge_not_found");
    expect(named.reason?.message).toContain("could not list its tools");
    expect(named.reason?.message).not.toContain("not a judge server");
  });
});

describe("judgeWarnings: a write warns when its task's runs would not be judged", () => {
  const judge = (name: string): JudgeSourceView => ({ name, toolNames: ["judge", "list_judges"] });
  const port = (sources: JudgeSourceView[]) => ({ sources: async () => sources });

  it("warns no_judge, judge_ambiguous, and judge_not_found from the pipeline's own discovery", async () => {
    expect((await judgeWarnings(task(), port([])))[0]?.code).toBe("no_judge");
    expect((await judgeWarnings(task(), port([judge("a"), judge("b")])))[0]?.code).toBe(
      "judge_ambiguous",
    );
    const named = task({ judge: { server: "missing" } });
    const [notFound] = await judgeWarnings(named, port([judge("a")]));
    expect(notFound?.code).toBe("judge_not_found");
    expect(notFound?.message).toContain("Needs review");
    const notAJudge = task({ judge: { server: "crm" } });
    expect(
      (await judgeWarnings(notAJudge, port([{ name: "crm", toolNames: ["search"] }])))[0]?.code,
    ).toBe("judge_not_found");
  });

  it("is silent with one usable judge, or with no criteria", async () => {
    expect(await judgeWarnings(task(), port([judge("a")]))).toEqual([]);
    expect(
      await judgeWarnings(task({ judge: { server: "b" } }), port([judge("a"), judge("b")])),
    ).toEqual([]);
    expect(await judgeWarnings(task({ criteria: undefined }), port([]))).toEqual([]);
  });
});
