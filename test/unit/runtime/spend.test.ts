import { describe, expect, it } from "bun:test";
import { createSpendBalances, type SpendPricing, spendIn } from "../../../src/runtime/spend.ts";
import { emptyUsage, type TokenUsage } from "../../../src/usage/types.ts";

/** $1 per 1M input tokens, $10 per 1M output tokens. */
const PRICED: SpendPricing = {
  model: "test:priced",
  rates: { input: 1, output: 10, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};
const UNPRICED: SpendPricing = { model: "test:unpriced", rates: null };

function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return { ...emptyUsage(), inputTokens, outputTokens };
}

describe("spend accounts — live balances", () => {
  it("runs naming the same id share one balance, so together they cannot exceed it", () => {
    const balances = createSpendBalances();
    const account = { id: "acct-1", unit: "input_tokens" as const, remaining: 1000 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);

    expect(a.check(usage(600, 0))).toBeNull();
    a.debit(usage(600, 0));
    // Run b alone would fit 600, but the shared balance has 400 left.
    expect(b.check(usage(600, 0))).toBe("acct-1");
    expect(b.check(usage(400, 0))).toBeNull();
    b.debit(usage(400, 0));
    expect(a.check(usage(1, 0))).toBe("acct-1");
    expect(balances.balance("acct-1")).toBe(0);
  });

  it("the first run to name an id sets the balance; later runs' amounts are ignored", () => {
    const balances = createSpendBalances();
    balances.open([{ id: "acct", unit: "input_tokens", remaining: 100 }], PRICED);
    const later = balances.open([{ id: "acct", unit: "input_tokens", remaining: 10_000 }], PRICED);
    expect(balances.balance("acct")).toBe(100);
    expect(later.check(usage(101, 0))).toBe("acct");
  });

  it("discards the balance when the last run naming it ends", () => {
    const balances = createSpendBalances();
    const account = { id: "acct", unit: "output_tokens" as const, remaining: 50 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);
    a.debit(usage(0, 30));
    a.release();
    a.release(); // idempotent: must not drop b's hold
    expect(balances.balance("acct")).toBe(20);
    b.release();
    expect(balances.balance("acct")).toBeUndefined();

    // The next run to name it sets a fresh balance from what the source says is left.
    balances.open([{ ...account, remaining: 20 }], PRICED);
    expect(balances.balance("acct")).toBe(20);
  });

  it("names each id once even if a run lists it twice", () => {
    const balances = createSpendBalances();
    const account = { id: "acct", unit: "input_tokens" as const, remaining: 100 };
    const hold = balances.open([account, account], PRICED);
    expect(hold.debit(usage(10, 0))).toHaveLength(1);
    hold.release();
    expect(balances.balance("acct")).toBeUndefined();
  });

  it("checks every account and reports the first one that would be overrun", () => {
    const balances = createSpendBalances();
    const hold = balances.open(
      [
        { id: "roomy", unit: "input_tokens", remaining: 1_000_000 },
        { id: "tight", unit: "output_tokens", remaining: 100 },
      ],
      PRICED,
    );
    expect(hold.check(usage(500, 200))).toBe("tight");
    expect(hold.check(usage(500, 100))).toBeNull();
  });

  it("reports what each call took from every account, with the balance after it", () => {
    const balances = createSpendBalances();
    const hold = balances.open(
      [
        { id: "in", unit: "input_tokens", remaining: 1000 },
        { id: "out", unit: "output_tokens", remaining: 1000 },
        { id: "usd", unit: "usd", remaining: 1 },
      ],
      PRICED,
    );
    const debits = hold.debit(usage(100_000, 10_000));
    expect(debits).toEqual([
      { accountId: "in", unit: "input_tokens", amount: 100_000, remaining: -99_000 },
      { accountId: "out", unit: "output_tokens", amount: 10_000, remaining: -9_000 },
      // 100k × $1/M + 10k × $10/M = $0.10 + $0.10
      {
        accountId: "usd",
        unit: "usd",
        amount: expect.closeTo(0.2, 10),
        remaining: expect.closeTo(0.8, 10),
      },
    ]);
  });
});

describe("spend accounts — units", () => {
  it("input and output tokens count the usage's totals", () => {
    const u = { ...usage(1000, 200), cacheReadTokens: 800 };
    expect(spendIn("input_tokens", u, PRICED, "debit")).toBe(1000);
    expect(spendIn("output_tokens", u, PRICED, "debit")).toBe(200);
  });

  it("dollars use the model's rates, the same arithmetic as costBreakdown", () => {
    // 200k non-cached input at $1/M + 800k cache reads at $0.10/M + 50k output at $10/M.
    const u = { ...usage(1_000_000, 50_000), cacheReadTokens: 800_000 };
    expect(spendIn("usd", u, PRICED, "debit")).toBeCloseTo(0.2 + 0.08 + 0.5, 10);
  });

  it("a dollar account on a model with no known rates lets no call through", () => {
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "usd", unit: "usd", remaining: 1000 }], UNPRICED);
    expect(hold.check(usage(1, 1))).toBe("usd");
    expect(spendIn("usd", usage(1, 1), UNPRICED, "debit")).toBe(0);
  });
});
