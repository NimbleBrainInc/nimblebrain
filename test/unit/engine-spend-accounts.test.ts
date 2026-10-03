import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import type {
  EngineConfig,
  EngineEvent,
  SpendGate,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";
import { resolveMaxOutputTokens } from "../../src/runtime/resolve-max-output-tokens.ts";
import { createSpendBalances, type SpendAccount } from "../../src/runtime/spend.ts";
import { costBreakdown, resolveRates } from "../../src/usage/cost.ts";
import { createMockModel } from "../helpers/mock-model.ts";

/** A model whose catalog output ceiling is 128k, the case that used to stop every run. */
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
  } = {},
) {
  const sent: LanguageModelV4CallOptions[] = [];
  const model = createMockModel((options) => {
    sent.push(options);
    const call = sent.length;
    if (call === opts.throwOn) throw new Error("provider failed");
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
