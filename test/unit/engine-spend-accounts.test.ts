import { describe, expect, it } from "bun:test";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import {
  CUT_OFF_FINISH_RAW,
  type EngineConfig,
  type EngineEvent,
  type SpendGate,
  type ToolResult,
  type ToolSchema,
} from "../../src/engine/types.ts";
import {
  MODEL_GATEWAY_BUDGET_ACCOUNT,
  ModelBudgetSpentError,
} from "../../src/model/gateway-refusal.ts";
import { resolveMaxOutputTokens } from "../../src/runtime/resolve-max-output-tokens.ts";
import { createSpendBalances, type SpendAccount } from "../../src/runtime/spend.ts";
import { costBreakdown, resolveRates } from "../../src/usage/cost.ts";
import { createMockModel } from "../helpers/mock-model.ts";

/** A model whose catalog output ceiling is 128k, the case that must not stop every run. */
const BIG_MODEL = "anthropic:claude-opus-4-7";

const baseConfig: EngineConfig = {
  model: "test-model",
  maxIterations: 25,
  maxInputTokens: 500_000,
  maxOutputTokens: 1_000,
};

const tools: ToolSchema[] = [
  { name: "test__score", description: "Score one item", inputSchema: {} },
];

/**
 * A model that asks for a tool on every call until call `answerOn` (if any),
 * reporting `inputTokens` and the smaller of `writes` and the call's
 * `maxOutputTokens`, the most a real provider could write. Records each call's
 * options.
 */
function steadyRun(
  spend: SpendGate | undefined,
  opts: {
    config?: Partial<EngineConfig>;
    inputTokens?: number;
    writes?: number;
    answerOn?: number;
    throwOn?: number;
    /** What the call numbered `throwOn` throws; a provider failure when absent. */
    thrown?: () => Error;
  } = {},
) {
  const sent: LanguageModelV4CallOptions[] = [];
  const model = createMockModel((options) => {
    sent.push(options);
    const call = sent.length;
    if (call === opts.throwOn) throw opts.thrown?.() ?? new Error("provider failed");
    const usage = {
      inputTokens: opts.inputTokens ?? 1_000,
      outputTokens: Math.min(opts.writes ?? 10, options.maxOutputTokens ?? Infinity),
    };
    if (call === opts.answerOn) return { content: [{ type: "text", text: "done" }], ...usage };
    return {
      content: [
        { type: "tool-call", toolCallId: `call_${call}`, toolName: "test__score", input: "{}" },
      ],
      ...usage,
    };
  });
  const events: EngineEvent[] = [];
  const engine = new AgentEngine(
    model,
    new StaticToolRouter(
      tools,
      (): ToolResult => ({ content: textContent("scored"), isError: false }),
    ),
    { emit: (e) => events.push(e) },
  );
  const config: EngineConfig = { ...baseConfig, ...opts.config, ...(spend ? { spend } : {}) };
  return {
    run: () =>
      engine.run(
        config,
        "",
        [{ role: "user", content: [{ type: "text", text: "Score items" }] }],
        tools,
      ),
    sent,
    maxOutputs: () => sent.map((o) => o.maxOutputTokens),
    events,
  };
}

/** A hold on `accounts`, priced at `model`'s rates, used as the engine's gate. */
function holdOn(accounts: SpendAccount[], model = "test-model", balances = createSpendBalances()) {
  return balances.open(accounts, { model, rates: resolveRates(model) });
}

describe("AgentEngine spend accounts", () => {
  it("stops before a call whose input an account cannot cover, with stopReason spend_limit naming it", async () => {
    const hold = holdOn([{ id: "acct-in", unit: "input_tokens", remaining: 3_500 }]);
    const r = steadyRun(hold, { answerOn: 5 });
    const result = await r.run();

    // Calls 1–3 spend 3,000; call 4 is projected at 1,000, which passes 3,500.
    expect(result.stopReason).toBe("spend_limit");
    expect(result.spendAccountId).toBe("acct-in");
    expect(r.sent).toHaveLength(3);
    expect(result.iterations).toBe(3);
    expect(r.events.find((e) => e.type === "run.done")?.data.stopReason).toBe("spend_limit");
  });

  it("a 50,000 output budget on a 128k model runs, its calls clamped, until less than the floor is left", async () => {
    const ceiling = resolveMaxOutputTokens({ model: BIG_MODEL });
    expect(ceiling).toBe(128_000);
    const balances = createSpendBalances();
    const account: SpendAccount = { id: "acct-out", unit: "output_tokens", remaining: 50_000 };
    const hold = holdOn([account], BIG_MODEL, balances);
    const r = steadyRun(hold, {
      config: { model: BIG_MODEL, maxOutputTokens: ceiling },
      writes: 9_950,
    });
    const result = await r.run();

    // Each call is sent with what is left; after five, 250 is left, under the
    // 256-token floor, so the run stops there.
    expect(r.maxOutputs()).toEqual([50_000, 40_050, 30_100, 20_150, 10_200]);
    expect(result.stopReason).toBe("spend_limit");
    expect(result.spendAccountId).toBe("acct-out");
    expect(result.usage.outputTokens).toBe(49_750);
    expect(balances.balance("acct-out")).toBe(250);
    hold.release();
  });

  it("a 1M output budget is spendable to within one call of 1M", async () => {
    const ceiling = resolveMaxOutputTokens({ model: BIG_MODEL });
    const hold = holdOn([{ id: "acct-out", unit: "output_tokens", remaining: 1_000_000 }]);
    const r = steadyRun(hold, {
      config: { model: BIG_MODEL, maxOutputTokens: ceiling },
      writes: 120_000,
    });
    const result = await r.run();

    // Eight full calls (960,000), then one clamped to the 40,000 left.
    expect(r.maxOutputs().at(-1)).toBe(40_000);
    expect(result.stopReason).toBe("spend_limit");
    expect(result.usage.outputTokens).toBe(1_000_000);
    hold.release();
  });

  it("a dollar account clamps the call's output to what its balance pays for at the model's rates", async () => {
    const ceiling = resolveMaxOutputTokens({ model: BIG_MODEL });
    const rates = resolveRates(BIG_MODEL)!;
    const hold = holdOn([{ id: "acct-usd", unit: "usd", remaining: 1 }], BIG_MODEL);
    // Reported input stays within the projection, so nothing escapes the
    // reservation (input past the projection is the one documented overrun).
    const r = steadyRun(hold, {
      config: { model: BIG_MODEL, maxOutputTokens: ceiling },
      inputTokens: 1,
      writes: 1_000_000,
    });
    const result = await r.run();

    const first = r.maxOutputs()[0]!;
    expect(first).toBeLessThan(ceiling);
    // $1 at the output rate is the most it could be; the projected input takes some.
    expect(first).toBeLessThan(1_000_000 / Math.max(rates.output, rates.reasoning ?? 0));
    expect(result.stopReason).toBe("spend_limit");
    expect(result.spendAccountId).toBe("acct-usd");
    expect(costBreakdown(BIG_MODEL, result.usage, rates).total).toBeLessThanOrEqual(1);
    hold.release();
  });

  it("fits an Anthropic thinking budget, which the adapter adds on top, inside what the account allows", async () => {
    const model = "anthropic:claude-sonnet-4-5";
    const hold = holdOn([{ id: "acct-out", unit: "output_tokens", remaining: 20_000 }], model);
    const r = steadyRun(hold, {
      config: {
        model,
        maxOutputTokens: resolveMaxOutputTokens({ model }),
        thinking: { mode: "enabled", budgetTokens: 10_000, effort: "high", source: "operator" },
      },
      answerOn: 1,
    });
    await r.run();

    const sent = r.sent[0]!;
    const budget = (sent.providerOptions?.anthropic as { thinking?: { budgetTokens?: number } })
      ?.thinking?.budgetTokens;
    expect(budget).toBeGreaterThan(0);
    // max_tokens on the wire is maxOutputTokens + the thinking budget.
    expect(sent.maxOutputTokens!).toBeGreaterThanOrEqual(256);
    expect(sent.maxOutputTokens! + budget!).toBeLessThanOrEqual(20_000);
    hold.release();
  });

  it("two runs sharing an account cannot together exceed it", async () => {
    const balances = createSpendBalances();
    const account: SpendAccount = { id: "shared", unit: "input_tokens", remaining: 6_500 };
    const a = holdOn([account], "test-model", balances);
    const b = holdOn([account], "test-model", balances);
    const ra = steadyRun(a, { answerOn: 5 });
    const rb = steadyRun(b, { answerOn: 5 });

    const [resA, resB] = await Promise.all([ra.run(), rb.run()]);
    const spent = resA.usage.inputTokens + resB.usage.inputTokens;
    // Alone, either run would have completed (5,000 ≤ 6,500).
    expect(spent).toBeLessThanOrEqual(6_500);
    expect([resA.stopReason, resB.stopReason]).toContain("spend_limit");
    expect(balances.balance("shared")).toBe(6_500 - spent);

    a.release();
    b.release();
    expect(balances.balance("shared")).toBeUndefined();
  });

  it("a call that throws leaves its reservation until the run's hold is released", async () => {
    const balances = createSpendBalances();
    const account: SpendAccount = { id: "acct-out", unit: "output_tokens", remaining: 10_000 };
    const hold = holdOn([account], "test-model", balances);
    const other = holdOn([account], "test-model", balances);
    const r = steadyRun(hold, { config: { maxOutputTokens: 8_000 }, throwOn: 1 });
    await expect(r.run()).rejects.toThrow("provider failed");

    const ask = { inputTokens: 0, maxOutputTokens: 10_000, minOutputTokens: 256 };
    expect(other.check(ask)).toEqual({ maxOutputTokens: 2_000 });
    hold.release();
    expect(other.check(ask)).toEqual({ maxOutputTokens: 10_000 });
    other.release();
  });

  it("a run with no accounts is unchanged", async () => {
    const r = steadyRun(undefined, { answerOn: 5 });
    const result = await r.run();
    expect(result.stopReason).toBe("complete");
    expect(result.spendAccountId).toBeUndefined();
    expect(r.sent).toHaveLength(5);
    expect(r.maxOutputs().every((m) => m === baseConfig.maxOutputTokens)).toBe(true);
  });
});

describe("AgentEngine on the model gateway's budget refusal", () => {
  it("stops the run at once with spend_limit naming the gateway's account, not retried, not an error", async () => {
    const r = steadyRun(undefined, { throwOn: 3, thrown: () => new ModelBudgetSpentError() });
    const result = await r.run();

    expect(result.stopReason).toBe("spend_limit");
    expect(result.spendAccountId).toBe(MODEL_GATEWAY_BUDGET_ACCOUNT);
    // The refused call was sent once: no retry.
    expect(r.sent).toHaveLength(3);
    expect(result.iterations).toBe(2);
    expect(result.usage.inputTokens).toBe(2_000);
    const types = r.events.map((e) => e.type);
    expect(types).not.toContain("run.error");
    expect(types).not.toContain("llm.error");
    expect(r.events.find((e) => e.type === "run.done")?.data.stopReason).toBe("spend_limit");
  });

  it("still retries a provider's own 429", async () => {
    let throws = 1;
    const rateLimited = () =>
      Object.assign(new Error("rate_limit_error"), { statusCode: 429, isRetryable: true });
    const r = steadyRun(undefined, {
      answerOn: 3,
      throwOn: 2,
      thrown: () => {
        throws--;
        return rateLimited();
      },
    });
    // The mock counts the retried attempt as a call: 1, 2 (429), 2 again as 3.
    const result = await r.run();
    expect(throws).toBe(0);
    expect(result.stopReason).toBe("complete");
    expect(r.events.map((e) => e.type)).not.toContain("run.error");
  });
});

/** What one scripted model call does. */
type CutOffStep =
  | { kind: "tool"; inputTokens: number; cacheRead?: number; cacheWrite?: number }
  /** Stream `text`, then hang until the call's signal aborts. */
  | { kind: "stream"; text: string }
  /** Throw `err()`, after running `before` (which may abort the run). */
  | { kind: "throw"; err: () => Error; before?: () => void };

/**
 * A run on a model that plays `steps`, one per call, with `signal` as the run's
 * signal and `hold` as its spend gate. Returns the events and how many calls
 * reached the model.
 */
function cutOffRun(
  steps: CutOffStep[],
  opts: { signal: AbortSignal; hold: SpendGate; config?: Partial<EngineConfig> },
) {
  let calls = 0;
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("unused")),
    async doStream(options) {
      const step = steps[calls++];
      if (!step) throw new Error("no step scripted");
      if (step.kind === "throw") {
        step.before?.();
        throw step.err();
      }
      const signal = options.abortSignal;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (step.kind === "stream") {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: step.text });
            const fail = () =>
              controller.error(
                signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
              );
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
            return;
          }
          controller.enqueue({
            type: "tool-call",
            toolCallId: `call_${calls}`,
            toolName: "test__score",
            input: "{}",
          });
          controller.enqueue({
            type: "finish",
            usage: {
              inputTokens: {
                total: step.inputTokens,
                noCache: undefined,
                cacheRead: step.cacheRead,
                cacheWrite: step.cacheWrite,
              },
              outputTokens: { total: 10, text: undefined, reasoning: undefined },
            },
            finishReason: { unified: "tool-calls", raw: undefined },
          });
          controller.close();
        },
      });
      return { stream };
    },
  };
  const events: EngineEvent[] = [];
  const engine = new AgentEngine(
    model,
    new StaticToolRouter(
      tools,
      (): ToolResult => ({ content: textContent("scored"), isError: false }),
    ),
    { emit: (e) => events.push(e) },
  );
  const config: EngineConfig = {
    ...baseConfig,
    ...opts.config,
    spend: opts.hold,
    signal: opts.signal,
  };
  return {
    events,
    calls: () => calls,
    run: () =>
      engine.run(
        config,
        "",
        [{ role: "user", content: [{ type: "text", text: "Score items" }] }],
        tools,
      ),
    cutOff: () =>
      events.flatMap((e) =>
        e.type === "llm.done" && e.data.finishReasonRaw === CUT_OFF_FINISH_RAW ? [e.data] : [],
      ),
  };
}

describe("AgentEngine on a model call a cancel cuts off", () => {
  it("debits and records the cut-off call once, from its projected input and streamed output", async () => {
    const balances = createSpendBalances();
    const hold = holdOn(
      [{ id: "acct-in", unit: "input_tokens", remaining: 100_000 }],
      "test-model",
      balances,
    );
    const controller = new AbortController();
    const r = cutOffRun(
      [
        { kind: "tool", inputTokens: 1_000, cacheRead: 600, cacheWrite: 300 },
        { kind: "stream", text: "x".repeat(400) },
      ],
      { signal: controller.signal, hold },
    );
    // Stop is pressed once the second call has streamed its text.
    r.events.push = new Proxy(r.events.push, {
      apply(target, self, args: EngineEvent[]) {
        if (args[0]?.type === "text.delta") queueMicrotask(() => controller.abort());
        return Reflect.apply(target, self, args);
      },
    });
    await expect(r.run()).rejects.toMatchObject({ name: "AbortError" });

    const [cut, ...more] = r.cutOff();
    expect(more).toHaveLength(0);
    expect(cut!.content).toEqual([]);
    expect(cut!.finishReason).toBe("stop");
    // The call's input is at least the previous call's (the prefix only grows),
    // and the part the previous call read or wrote to the cache is a cache read.
    expect(cut!.usage.inputTokens).toBeGreaterThanOrEqual(1_000);
    expect(cut!.usage.cacheReadTokens).toBe(900);
    expect(cut!.usage.outputTokens).toBeGreaterThan(0);
    // The cut-off call lands before the run ends cancelled.
    const types = r.events.map((e) => e.type);
    expect(types.lastIndexOf("llm.done")).toBeLessThan(types.indexOf("run.done"));
    expect(r.events.find((e) => e.type === "run.done")?.data.stopReason).toBe("cancelled");
    // Both calls are debited: the reported one and the cut-off one.
    expect(balances.balance("acct-in")).toBe(100_000 - 1_000 - cut!.usage.inputTokens);
    hold.release();
  });

  it("prices a run's first call cut off as uncached input, at most its output ceiling", async () => {
    const hold = holdOn([{ id: "acct-out", unit: "output_tokens", remaining: 100_000 }]);
    const controller = new AbortController();
    const r = cutOffRun([{ kind: "stream", text: "x".repeat(4_000) }], {
      signal: controller.signal,
      hold,
      config: { maxOutputTokens: 300 },
    });
    r.events.push = new Proxy(r.events.push, {
      apply(target, self, args: EngineEvent[]) {
        if (args[0]?.type === "text.delta") queueMicrotask(() => controller.abort());
        return Reflect.apply(target, self, args);
      },
    });
    await expect(r.run()).rejects.toMatchObject({ name: "AbortError" });

    const [cut] = r.cutOff();
    expect(cut!.usage.cacheReadTokens).toBe(0);
    expect(cut!.usage.inputTokens).toBeGreaterThan(0);
    expect(cut!.usage.outputTokens).toBe(300);
    hold.release();
  });

  it("records nothing when the cancel lands during a retry's backoff", async () => {
    const hold = holdOn([{ id: "acct-in", unit: "input_tokens", remaining: 100_000 }]);
    const controller = new AbortController();
    const overloaded = () =>
      Object.assign(new Error("overloaded"), { statusCode: 529, isRetryable: true });
    const r = cutOffRun(
      [{ kind: "throw", err: overloaded, before: () => setTimeout(() => controller.abort(), 5) }],
      { signal: controller.signal, hold },
    );
    await expect(r.run()).rejects.toMatchObject({ name: "AbortError" });

    expect(r.calls()).toBe(1);
    expect(r.cutOff()).toHaveLength(0);
    hold.release();
  });

  it("records nothing for a call the cancel stops before it is sent", async () => {
    const hold = holdOn([{ id: "acct-in", unit: "input_tokens", remaining: 100_000 }]);
    const controller = new AbortController();
    const r = cutOffRun([{ kind: "tool", inputTokens: 1_000 }], {
      signal: controller.signal,
      hold,
      // A history rewrite that sees the cancel and returns rather than throws.
      config: {
        hooks: {
          rewriteHistory: () => {
            controller.abort();
            return undefined;
          },
        },
      },
    });
    await expect(r.run()).rejects.toMatchObject({ name: "AbortError" });

    expect(r.calls()).toBe(1);
    expect(r.cutOff()).toHaveLength(0);
    hold.release();
  });

  it("records nothing for a gateway refusal that lands as the run is cancelled", async () => {
    const hold = holdOn([{ id: "acct-in", unit: "input_tokens", remaining: 100_000 }]);
    const controller = new AbortController();
    const r = cutOffRun(
      [
        { kind: "tool", inputTokens: 1_000 },
        { kind: "throw", err: () => new ModelBudgetSpentError(), before: () => controller.abort() },
      ],
      { signal: controller.signal, hold },
    );
    await expect(r.run()).rejects.toBeInstanceOf(ModelBudgetSpentError);

    expect(r.calls()).toBe(2);
    expect(r.cutOff()).toHaveLength(0);
    hold.release();
  });
});
