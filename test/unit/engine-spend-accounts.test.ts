import { describe, expect, it } from "bun:test";
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
import {
  createSpendBalances,
  type SpendAccount,
  type SpendBalances,
  type SpendDebit,
} from "../../src/runtime/spend.ts";
import { createMockModel } from "../helpers/mock-model.ts";

const baseConfig: EngineConfig = {
  model: "test-model",
  maxIterations: 25,
  maxInputTokens: 500_000,
  maxOutputTokens: 1_000,
};

const tools: ToolSchema[] = [
  { name: "test__score", description: "Score one item", inputSchema: {} },
];

/** The runtime's adapter, minus pricing: a hold on `accounts` as an engine gate. */
function gateOn(balances: SpendBalances, accounts: SpendAccount[], debits: SpendDebit[] = []) {
  const hold = balances.open(accounts, { model: "test-model", rates: null });
  const gate: SpendGate = {
    check: (p) => hold.check(p),
    debit: (u) => {
      debits.push(...hold.debit(u));
    },
  };
  return { gate, release: () => hold.release() };
}

/**
 * Each call reports 1,000 input and 10 output tokens and asks for a tool, until
 * the fifth, which answers. Uncapped: 5 calls, 5,000 input tokens.
 */
function steadyRun(spend?: SpendGate) {
  let calls = 0;
  const model = createMockModel(() => {
    calls++;
    if (calls === 5) {
      return { content: [{ type: "text", text: "done" }], inputTokens: 1_000, outputTokens: 10 };
    }
    return {
      content: [
        { type: "tool-call", toolCallId: `call_${calls}`, toolName: "test__score", input: "{}" },
      ],
      inputTokens: 1_000,
      outputTokens: 10,
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
  return {
    run: () =>
      engine.run(
        spend ? { ...baseConfig, spend } : baseConfig,
        "",
        [{ role: "user", content: [{ type: "text", text: "Score items" }] }],
        tools,
      ),
    modelCalls: () => calls,
    events,
  };
}

describe("AgentEngine spend accounts", () => {
  it("stops before the call that would overrun an account, with stopReason spend_limit naming it", async () => {
    const debits: SpendDebit[] = [];
    const { gate } = gateOn(
      createSpendBalances(),
      [{ id: "acct-in", unit: "input_tokens", remaining: 3_500 }],
      debits,
    );
    const r = steadyRun(gate);
    const result = await r.run();

    // Calls 1–3 spend 3,000; call 4 is projected at 1,000, which passes 3,500.
    expect(result.stopReason).toBe("spend_limit");
    expect(result.spendAccountId).toBe("acct-in");
    expect(r.modelCalls()).toBe(3);
    expect(result.iterations).toBe(3);
    expect(r.events.find((e) => e.type === "run.done")?.data.stopReason).toBe("spend_limit");

    // Every call that ran was debited, and reported.
    expect(debits.map((d) => d.amount)).toEqual([1_000, 1_000, 1_000]);
    expect(debits.at(-1)?.remaining).toBe(500);
  });

  it("projects output at the call's ceiling", async () => {
    // Each call writes 10 tokens, but the ceiling is 1,000, so an output
    // account with 999 left refuses the very first call.
    const { gate } = gateOn(createSpendBalances(), [
      { id: "acct-out", unit: "output_tokens", remaining: 999 },
    ]);
    const r = steadyRun(gate);
    const result = await r.run();
    expect(result.stopReason).toBe("spend_limit");
    expect(result.spendAccountId).toBe("acct-out");
    expect(r.modelCalls()).toBe(0);
  });

  it("two runs sharing an account cannot together exceed it", async () => {
    const balances = createSpendBalances();
    const account: SpendAccount = { id: "shared", unit: "input_tokens", remaining: 6_500 };
    const a = gateOn(balances, [account]);
    const b = gateOn(balances, [account]);
    const ra = steadyRun(a.gate);
    const rb = steadyRun(b.gate);

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

  it("a run with no accounts is unchanged", async () => {
    const r = steadyRun();
    const result = await r.run();
    expect(result.stopReason).toBe("complete");
    expect(result.spendAccountId).toBeUndefined();
    expect(r.modelCalls()).toBe(5);
  });
});
