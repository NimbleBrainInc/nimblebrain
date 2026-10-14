import { describe, expect, it } from "bun:test";
import { createSpendBalances, type SpendPricing, spendIn } from "../../../src/runtime/spend.ts";
import { emptyUsage, type TokenUsage } from "../../../src/usage/types.ts";

/** $1 per 1M input tokens (up to $2 for a 1h cache write), $10 per 1M output tokens. */
const PRICED: SpendPricing = {
  model: "test:priced",
  rates: { input: 1, output: 10, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};
const UNPRICED: SpendPricing = { model: "test:unpriced", rates: null };

function usage(inputTokens: number, outputTokens: number): TokenUsage {
  return { ...emptyUsage(), inputTokens, outputTokens };
}

/** A call projecting `inputTokens`, asking for up to `max` output, accepting no less than `min`. */
function call(inputTokens: number, max: number, min = 256) {
  return { inputTokens, maxOutputTokens: max, minOutputTokens: min };
}

describe("spend accounts — clamping a call", () => {
  it("an output account clamps the call to its balance, and refuses below the floor", () => {
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "out", unit: "output_tokens", remaining: 50_000 }], PRICED);
    expect(hold.check(call(1_000, 128_000))).toEqual({ maxOutputTokens: 50_000 });
    hold.debit(usage(1_000, 49_800));
    // 200 left, below the 256 floor.
    expect(hold.check(call(1_000, 128_000))).toEqual({ accountId: "out" });
  });

  it("a call asking for less than the balance is not clamped", () => {
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "out", unit: "output_tokens", remaining: 50_000 }], PRICED);
    expect(hold.check(call(1_000, 4_000))).toEqual({ maxOutputTokens: 4_000 });
  });

  it("an input account refuses a call whose projected input does not fit, and never clamps output", () => {
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "in", unit: "input_tokens", remaining: 1_000 }], PRICED);
    expect(hold.check(call(1_001, 8_000))).toEqual({ accountId: "in" });
    expect(hold.check(call(1_000, 8_000))).toEqual({ maxOutputTokens: 8_000 });
  });

  it("a dollar account allows the output its balance pays for after the input, at worst-case rates", () => {
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "usd", unit: "usd", remaining: 1 }], PRICED);
    // Input at the dearest input-side rate ($2/M): 100k → $0.20. The $0.80 left
    // pays for 80,000 output tokens at $10/M.
    expect(hold.check(call(100_000, 128_000))).toEqual({ maxOutputTokens: 80_000 });
    // Input alone past the balance: refused.
    const other = createSpendBalances().open([{ id: "usd", unit: "usd", remaining: 0.1 }], PRICED);
    expect(other.check(call(100_000, 128_000))).toEqual({ accountId: "usd" });
  });

  it("names the account that refuses the call", () => {
    const balances = createSpendBalances();
    const hold = balances.open(
      [
        { id: "roomy", unit: "output_tokens", remaining: 1_000_000 },
        { id: "tight", unit: "output_tokens", remaining: 100 },
      ],
      PRICED,
    );
    expect(hold.check(call(0, 8_000))).toEqual({ accountId: "tight" });
  });

  it("a dollar account on a model with no known rates lets no call through", () => {
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "usd", unit: "usd", remaining: 1000 }], UNPRICED);
    expect(hold.check(call(1, 1_000))).toEqual({ accountId: "usd" });
  });
});

describe("spend accounts — reservations", () => {
  it("two runs holding one 10,000 balance cannot together reserve past it", () => {
    const balances = createSpendBalances();
    const account = { id: "shared", unit: "output_tokens" as const, remaining: 10_000 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);

    expect(a.check(call(0, 8_000))).toEqual({ maxOutputTokens: 8_000 });
    // b sees a's reservation: 2,000 available, not 10,000.
    expect(b.check(call(0, 8_000))).toEqual({ maxOutputTokens: 2_000 });
    // Both calls write everything they were allowed: exactly the balance.
    a.debit(usage(0, 8_000));
    b.debit(usage(0, 2_000));
    expect(balances.balance("shared")).toBe(0);
    expect(a.check(call(0, 8_000))).toEqual({ accountId: "shared" });
  });

  it("concurrent input reservations refuse a call the balance cannot cover alongside them", () => {
    const balances = createSpendBalances();
    const account = { id: "in", unit: "input_tokens" as const, remaining: 10_000 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);
    expect(a.check(call(6_000, 1_000))).toEqual({ maxOutputTokens: 1_000 });
    expect(b.check(call(6_000, 1_000))).toEqual({ accountId: "in" });
    expect(b.check(call(4_000, 1_000))).toEqual({ maxOutputTokens: 1_000 });
  });

  it("a debit releases the call's reservation and subtracts what it actually cost", () => {
    const balances = createSpendBalances();
    const account = { id: "out", unit: "output_tokens" as const, remaining: 10_000 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);
    a.check(call(0, 8_000));
    a.debit(usage(0, 3_000));
    expect(balances.balance("out")).toBe(7_000);
    expect(b.check(call(0, 128_000))).toEqual({ maxOutputTokens: 7_000 });
  });

  it("releasing a run frees the reservation of a call it never debited", () => {
    const balances = createSpendBalances();
    const account = { id: "out", unit: "output_tokens" as const, remaining: 10_000 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);
    a.check(call(0, 8_000));
    // a's call aborted or threw: no debit, and the run ends.
    a.release();
    expect(b.check(call(0, 128_000))).toEqual({ maxOutputTokens: 10_000 });
  });

  it("a check replaces the reservation a run still holds", () => {
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "out", unit: "output_tokens", remaining: 10_000 }], PRICED);
    hold.check(call(0, 8_000));
    expect(hold.check(call(0, 8_000))).toEqual({ maxOutputTokens: 8_000 });
  });

  it("actual input past the projection is debited in full, taking the balance below zero by the excess", () => {
    const balances = createSpendBalances();
    const account = { id: "in", unit: "input_tokens" as const, remaining: 1_000 };
    const a = balances.open([account], PRICED);
    expect(a.check(call(1_000, 100))).toEqual({ maxOutputTokens: 100 });
    a.debit(usage(1_200, 0));
    expect(balances.balance("in")).toBe(-200);
  });
});

describe("spend accounts — live balances", () => {
  it("the first run to name an id sets the balance; later runs' amounts are ignored", () => {
    const balances = createSpendBalances();
    balances.open([{ id: "acct", unit: "input_tokens", remaining: 100 }], PRICED);
    const later = balances.open([{ id: "acct", unit: "input_tokens", remaining: 10_000 }], PRICED);
    expect(balances.balance("acct")).toBe(100);
    expect(later.check(call(101, 100))).toEqual({ accountId: "acct" });
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
    hold.debit(usage(10, 0));
    expect(balances.balance("acct")).toBe(90);
    hold.release();
    expect(balances.balance("acct")).toBeUndefined();
  });
});

describe("spend accounts — units", () => {
  it("input and output tokens count the usage's totals", () => {
    const u = { ...usage(1000, 200), cacheReadTokens: 800 };
    expect(spendIn("input_tokens", u, PRICED)).toBe(1000);
    expect(spendIn("output_tokens", u, PRICED)).toBe(200);
  });

  it("dollars debit with the model's rates, the same arithmetic as costBreakdown", () => {
    // 200k non-cached input at $1/M + 800k cache reads at $0.10/M + 50k output at $10/M.
    const u = { ...usage(1_000_000, 50_000), cacheReadTokens: 800_000 };
    expect(spendIn("usd", u, PRICED)).toBeCloseTo(0.2 + 0.08 + 0.5, 10);
    expect(spendIn("usd", usage(1, 1), UNPRICED)).toBe(0);
  });
});
