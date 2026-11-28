import { describe, expect, it } from "bun:test";
import { createSpendBalances, type SpendPricing, spendIn } from "../../../src/runtime/spend.ts";
import { resolveRates } from "../../../src/usage/cost.ts";
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

  it("a dollar account projects at the dearest rate card a longer prompt can reach", () => {
    const tiered: SpendPricing = {
      model: "test:tiered",
      rates: {
        ...PRICED.rates!,
        tiers: [
          {
            aboveInputTokens: 100_000,
            input: 5,
            output: 50,
            cacheRead: 0.5,
            cacheWrite5m: 6.25,
            cacheWrite1h: 10,
          },
        ],
      },
    };
    const balances = createSpendBalances();
    const hold = balances.open([{ id: "usd", unit: "usd", remaining: 1 }], tiered);
    // $1 minus 1,000 input at $10/M (the 1h write on the long card) leaves $0.99,
    // which buys 19,800 output at $50/M.
    expect(hold.check(call(1_000, 128_000))).toEqual({ maxOutputTokens: 19_800 });
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

  it("a refusal reads reserved only when other runs' reservations held what the balance would pay", () => {
    const balances = createSpendBalances();
    const account = { id: "in", unit: "input_tokens" as const, remaining: 10_000 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);
    expect(a.check(call(6_000, 1_000))).toEqual({ maxOutputTokens: 1_000 });
    // 6,000 fits the balance; a's reservation held it.
    expect(b.check(call(6_000, 1_000))).toEqual({ accountId: "in" });
    expect(b.stopOf("in")).toBe("reserved");
    // 12,000 fits no balance, whatever anyone reserves.
    expect(b.check(call(12_000, 1_000))).toEqual({ accountId: "in" });
    expect(b.stopOf("in")).toBe("exhausted");
  });

  it("runs sharing a balance too small for one call each read exhausted, never reserved", () => {
    const balances = createSpendBalances();
    // $0.0001 cannot pay for a 1,000-token prompt at $2/M.
    const account = { id: "batch", unit: "usd" as const, remaining: 0.0001, sharedBy: 2 };
    const a = balances.open([account], PRICED);
    const b = balances.open([account], PRICED);
    expect(a.check(call(1_000, 8_000))).toEqual({ accountId: "batch" });
    expect(b.check(call(1_000, 8_000))).toEqual({ accountId: "batch" });
    expect(a.stopOf("batch")).toBe("exhausted");
    expect(b.stopOf("batch")).toBe("exhausted");
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

describe("spend accounts — a run reserved as a whole (ADR-0063)", () => {
  it("grants a token account's balance divided by the runs that may share it", () => {
    const balances = createSpendBalances();
    const hold = balances.open(
      [{ id: "in", unit: "input_tokens", remaining: 30_000, sharedBy: 3 }],
      PRICED,
    );
    expect(hold.reserveRun()).toEqual({ tokens: 10_000, accountId: "in" });
  });

  it("gives each run sharing the account the same share, and never more than is unreserved", () => {
    const balances = createSpendBalances();
    const account = { id: "in", unit: "input_tokens" as const, remaining: 30_000, sharedBy: 2 };
    expect(balances.open([account], PRICED).reserveRun().tokens).toBe(15_000);
    expect(balances.open([account], PRICED).reserveRun().tokens).toBe(15_000);
    // A third run past the declared sharing finds nothing left unreserved.
    const third = balances.open([account], PRICED);
    expect(third.reserveRun().tokens).toBe(0);
    // Its share was cut by the others' reservations; theirs was their part.
    expect(third.stopOf("in")).toBe("reserved");
  });

  it("a whole-run share that is its full part reads exhausted when spent", () => {
    const balances = createSpendBalances();
    const account = { id: "in", unit: "input_tokens" as const, remaining: 30_000, sharedBy: 2 };
    const hold = balances.open([account], PRICED);
    hold.reserveRun();
    expect(hold.stopOf("in")).toBe("exhausted");
  });

  it("prices a dollar share at the dearest per-token rate, and grants none unpriced", () => {
    const balances = createSpendBalances();
    // $1 at $10 per 1M output tokens, the dearest rate, buys 100,000 tokens.
    const priced = balances.open([{ id: "usd", unit: "usd", remaining: 1 }], PRICED);
    const grant = priced.reserveRun();
    // Rounded down, never up: floating point may land a token short.
    expect(grant.accountId).toBe("usd");
    expect(grant.tokens).toBeLessThanOrEqual(100_000);
    expect(grant.tokens).toBeGreaterThanOrEqual(99_999);
    const unpriced = balances.open([{ id: "usd2", unit: "usd", remaining: 1 }], UNPRICED);
    expect(unpriced.reserveRun()).toEqual({ tokens: 0, accountId: "usd2" });
  });

  it("names the account whose share is least", () => {
    const balances = createSpendBalances();
    const hold = balances.open(
      [
        { id: "big", unit: "input_tokens", remaining: 50_000 },
        { id: "small", unit: "output_tokens", remaining: 4_000 },
      ],
      PRICED,
    );
    expect(hold.reserveRun()).toEqual({ tokens: 4_000, accountId: "small" });
  });

  it("draws the reservation down as the run spends, and returns the rest when it ends", () => {
    const balances = createSpendBalances();
    const account = { id: "in", unit: "input_tokens" as const, remaining: 20_000, sharedBy: 2 };
    const first = balances.open([account], PRICED);
    expect(first.reserveRun().tokens).toBe(10_000);
    first.debit(usage(4_000, 100));
    expect(balances.balance("in")).toBe(16_000);
    // A second run sees the first's unspent 6,000 still held.
    const second = balances.open([account], PRICED);
    expect(second.reserveRun().tokens).toBe(8_000);
    first.release();
    second.release();
    expect(balances.balance("in")).toBeUndefined();
  });
});

/**
 * A run held by the gateway's grant is stopped once the tokens the gateway
 * counts pass `reserveRun().tokens`. The gateway counts one number: input plus
 * output, every kind alike, cache reads and writes included. These tests hold
 * the grant to both sides of its contract, measured in that count.
 */
describe("spend accounts — the grant the gateway enforces", () => {
  const SONNET: SpendPricing = {
    model: "anthropic:claude-sonnet-4-6",
    rates: resolveRates("anthropic:claude-sonnet-4-6"),
  };

  /** The tokens the gateway counts for one call: all input and all output. */
  const counted = (u: TokenUsage) => u.inputTokens + u.outputTokens;

  /**
   * A production-shaped run of 20 calls. Call 1 writes the 20k-token prefix
   * with a 1h TTL; each later call reads the cached prefix and history, writes
   * the new turn with a 5m TTL, and sends a little uncached input. About 83% of
   * the counted tokens are cache reads.
   */
  const CACHE_HEAVY_RUN: TokenUsage[] = [
    {
      ...usage(20_000, 800),
      cacheWriteTokens: 20_000,
      cacheWrite1hTokens: 20_000,
    },
    ...Array.from({ length: 19 }, () => ({
      ...usage(30_000, 800),
      cacheReadTokens: 26_500,
      cacheWriteTokens: 1_750,
      cacheWrite1hTokens: 0,
    })),
  ];

  /** Each call's input is ten times its output. */
  const PROMPT_HEAVY_CALL = usage(20_000, 2_000);

  it("the fixtures are what the tests below say they are", () => {
    expect(SONNET.rates).not.toBeNull();
    const total = CACHE_HEAVY_RUN.reduce((sum, u) => sum + counted(u), 0);
    const reads = CACHE_HEAVY_RUN.reduce((sum, u) => sum + (u.cacheReadTokens ?? 0), 0);
    expect(reads / total).toBeGreaterThan(0.82);
    expect(reads / total).toBeLessThan(0.84);
    expect(PROMPT_HEAVY_CALL.inputTokens).toBe(10 * PROMPT_HEAVY_CALL.outputTokens);
  });

  // Invariant: a run is never held above its terms. The grant, spent entirely
  // on the kind of token its account prices dearest, costs no more than the
  // account in the account's own unit.
  it("never grants more than the account pays for, whatever kind of token spends it", () => {
    const usd = createSpendBalances()
      .open([{ id: "usd", unit: "usd", remaining: 1 }], SONNET)
      .reserveRun().tokens;
    const asOutput = usage(0, usd);
    const as1hWrite = { ...usage(usd, 0), cacheWriteTokens: usd, cacheWrite1hTokens: usd };
    expect(spendIn("usd", asOutput, SONNET)).toBeLessThanOrEqual(1);
    expect(spendIn("usd", as1hWrite, SONNET)).toBeLessThanOrEqual(1);

    const out = createSpendBalances()
      .open([{ id: "out", unit: "output_tokens", remaining: 50_000 }], SONNET)
      .reserveRun().tokens;
    expect(spendIn("output_tokens", usage(0, out), SONNET)).toBeLessThanOrEqual(50_000);

    const inp = createSpendBalances()
      .open([{ id: "in", unit: "input_tokens", remaining: 50_000 }], SONNET)
      .reserveRun().tokens;
    expect(spendIn("input_tokens", usage(inp, 0), SONNET)).toBeLessThanOrEqual(50_000);
  });

  // Invariant: a run that can pay is admitted. A run whose priced cost is 0.8x
  // its `usd` account must fit inside the grant. Expected to fail: the gateway
  // enforces a count of tokens, every kind alike, and `reserveRun` converts
  // dollars to that count at the dearest per-token rate, so a mix that is
  // mostly cache reads is stopped after a small part of its dollars. When the
  // grant is enforced in the account's unit, this passes and `bun test` reports
  // it; make it a plain `it` then.
  it.failing("admits a cache-heavy run whose cost is 0.8x its dollar account", () => {
    const cost = CACHE_HEAVY_RUN.reduce((sum, u) => sum + spendIn("usd", u, SONNET), 0);
    const grant = createSpendBalances()
      .open([{ id: "usd", unit: "usd", remaining: cost / 0.8 }], SONNET)
      .reserveRun().tokens;
    const total = CACHE_HEAVY_RUN.reduce((sum, u) => sum + counted(u), 0);
    expect(total).toBeLessThanOrEqual(grant);
  });

  // Invariant: a run that can pay is admitted. An `output_tokens` budget B lets
  // the run write at least 0.95B output before the grant stops it. Expected to
  // fail: `reserveRun` grants B tokens and the gateway counts input against it
  // too, so a run whose prompts are ten times its output stops near B/11. When
  // the grant is enforced in the account's unit, this passes and `bun test`
  // reports it; make it a plain `it` then.
  it.failing("admits calls until an output budget is nearly spent when input is 10x output", () => {
    const budget = 100_000;
    const grant = createSpendBalances()
      .open([{ id: "out", unit: "output_tokens", remaining: budget }], SONNET)
      .reserveRun().tokens;
    let countedSoFar = 0;
    let output = 0;
    while (output < budget && countedSoFar + counted(PROMPT_HEAVY_CALL) <= grant) {
      countedSoFar += counted(PROMPT_HEAVY_CALL);
      output += PROMPT_HEAVY_CALL.outputTokens;
    }
    expect(output).toBeGreaterThanOrEqual(0.95 * budget);
  });
});
