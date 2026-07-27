import { describe, expect, it } from "bun:test";
import { DEFAULT_THINKING_EFFORT } from "../../src/engine/types.ts";
import {
  buildNebiusCatalog,
  DEFAULT_OUTPUT_LIMIT,
  MIN_USABLE_CONTEXT,
  probeModel,
  type RawNebiusModel,
} from "../../src/model/sync-nebius.ts";

describe("sync-nebius invariants", () => {
  it("keeps the context floor clear of the output default", () => {
    // Dropping the output clamp (`Math.min(DEFAULT_OUTPUT_LIMIT, context)`) was
    // only safe because nothing past the gate can have a context smaller than
    // the output we hand it. That guarantee used to be mechanical and is now
    // structural, so it needs a tripwire: lower the floor under the output
    // default and every catalogued model gets a max_tokens above its window.
    expect(MIN_USABLE_CONTEXT).toBeGreaterThan(DEFAULT_OUTPUT_LIMIT);
  });

  it("keeps the default thinking tier one the wire takes unchanged", () => {
    // The probe sends DEFAULT_THINKING_EFFORT directly, while the runtime sends
    // it through `toOpenAIEffort`, which clamps `xhigh`/`max` to `high`. Equal
    // today. If the default ever moves into the clamped range the probe would
    // send a tier no run sends — fail-closed (a warned false exclusion), but
    // still the probe measuring something other than the runtime.
    expect(["low", "medium", "high"]).toContain(DEFAULT_THINKING_EFFORT);
  });
});

const curated = [{ id: "org/Model-A", name: "Model A", family: "fam" }];

function raw(overrides: Partial<RawNebiusModel> = {}): RawNebiusModel {
  return {
    id: "org/Model-A",
    context_length: 131072,
    pricing: { prompt: "0.00000015", completion: "0.0000006" },
    supported_features: ["tools", "reasoning"],
    ...overrides,
  };
}

describe("buildNebiusCatalog", () => {
  it("converts per-token pricing to USD per 1M without float noise", () => {
    // 0.13/M is the case that surfaces float noise (0.13 * 1e6 -> 0.1299999…).
    const models = buildNebiusCatalog([raw({ pricing: { prompt: "0.00000013", completion: "0.0000004" } })], curated);
    expect(models["org/Model-A"]!.cost).toEqual({ input: 0.13, output: 0.4 });
  });

  it("derives toolCall and reasoning from supported_features", () => {
    const toolsOnly = buildNebiusCatalog([raw({ supported_features: ["tools"] })], curated);
    expect(toolsOnly["org/Model-A"]!.capabilities).toMatchObject({ toolCall: true, reasoning: false });

    const both = buildNebiusCatalog([raw({ supported_features: ["tools", "reasoning"] })], curated);
    expect(both["org/Model-A"]!.capabilities).toMatchObject({ toolCall: true, reasoning: true });
  });

  it("excludes a model that declares no context_length at all", () => {
    // More dangerous than a small window, not less: it would catalogue as
    // `context: 0`, and `resolveMessageBudget` treats only `null` as a catalog
    // miss — so the fallback never fires and every turn resolves to budget 0.
    const noCtx = buildNebiusCatalog([raw({ context_length: undefined })], curated);
    expect(noCtx["org/Model-A"]).toBeUndefined();
  });

  it("uses the real context and pins output to the platform default", () => {
    const big = buildNebiusCatalog([raw({ context_length: 1048576 })], curated);
    expect(big["org/Model-A"]!.limits).toEqual({ context: 1048576, output: 16384 });

    // The gate guarantees context >= MIN_USABLE_CONTEXT, so output never needs
    // clamping to the window — a model just over the floor still gets the default.
    const nearFloor = buildNebiusCatalog([raw({ context_length: 64_000 })], curated);
    expect(nearFloor["org/Model-A"]!.limits).toEqual({ context: 64_000, output: 16384 });

    // A window too small to hold one turn is excluded outright, not clamped —
    // the probe cannot catch this class (an 8K model answers the toy prompt
    // fine), and `Kimi-K2.7-Code` / `Kimi-K3` are both served at 8000 here.
    const small = buildNebiusCatalog([raw({ context_length: 8000 })], curated);
    expect(small["org/Model-A"]).toBeUndefined();
  });

  it("skips a curated id the account doesn't serve", () => {
    const models = buildNebiusCatalog([raw({ id: "org/Different" })], curated);
    expect(models["org/Model-A"]).toBeUndefined();
    expect(Object.keys(models)).toHaveLength(0);
  });
});

describe("probeModel", () => {
  const KEY = "test-key";
  const okBody = { choices: [{ message: { tool_calls: [{ id: "1", function: { name: "get_weather" } }] } }] };

  function fetchReturning(body: unknown, init: { ok?: boolean; status?: number } = {}) {
    return (async () =>
      ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        statusText: "",
        json: async () => body,
      }) as unknown as Response) as unknown as typeof fetch;
  }

  it("passes a model that returns a real tool call", async () => {
    expect(await probeModel("org/Good", KEY, fetchReturning(okBody))).toEqual({ ok: true });
  });

  it("sends the auth header, the tool, and a budget big enough for a reasoning trace", async () => {
    // The fake fetch used to ignore its arguments, so a dropped header, a
    // malformed tool, or a shrunken budget all stayed green — and the budget is
    // exactly what produced this file's false negatives.
    let seen: { url?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {};
    const capturing = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, status: 200, statusText: "", json: async () => okBody } as unknown as Response;
    }) as unknown as typeof fetch;

    await probeModel("org/Model-A", KEY, capturing);
    expect(seen.url).toContain("/chat/completions");
    expect(seen.headers?.Authorization).toBe(`Bearer ${KEY}`);
    expect(seen.body?.model).toBe("org/Model-A");
    expect((seen.body?.tools as unknown[])?.length).toBe(1);
    // A reasoning model spends its trace against this budget before it can call.
    expect(seen.body?.max_tokens as number).toBeGreaterThanOrEqual(1024);
  });

  it("sends reasoning_effort only for a model that claims reasoning", async () => {
    // The runtime puts `reasoning_effort` on every call to a reasoning-flagged
    // nebius model (resolveThinking defaults to effort mode, and the adapter
    // reads its `openai` key for nebius too). Probing without it would verify a
    // request shape no run sends — the same gap as proving the tools half of
    // `supported_features` and assuming the reasoning half.
    //
    // Asserted in BOTH directions on purpose: a test that only checks the
    // parameter is present passes just as happily when it is always present,
    // which would send it to models the runtime's own gate excludes.
    const bodyFor = async (reasoning: boolean) => {
      let sent: Record<string, unknown> = {};
      const capturing = (async (_url: string, init: { body: string }) => {
        sent = JSON.parse(init.body);
        return { ok: true, status: 200, statusText: "", json: async () => okBody } as unknown as Response;
      }) as unknown as typeof fetch;
      await probeModel("org/Model-A", KEY, capturing, 30_000, reasoning);
      return sent;
    };

    expect((await bodyFor(true)).reasoning_effort).toBe("medium");
    expect((await bodyFor(false)).reasoning_effort).toBeUndefined();
  });

  it("reports truncation separately from refusing to call a tool", async () => {
    // The two are indistinguishable in the payload — no call either way — and
    // conflating them dropped two working models from the catalog.
    const truncated = { choices: [{ finish_reason: "length", message: {} }] };
    const outcome = await probeModel("org/Thinky", KEY, fetchReturning(truncated));
    expect(outcome).toMatchObject({ ok: false, reason: "truncated" });
  });

  it("rejects a model that answers in prose instead of calling the tool", async () => {
    // `supported_features: ["tools"]` is a claim; this is the check.
    const prose = { choices: [{ finish_reason: "stop", message: { content: "It is sunny in Paris." } }] };
    expect(await probeModel("org/Prose", KEY, fetchReturning(prose))).toEqual({
      ok: false,
      reason: "no_tool_calls",
    });
  });

  it("rejects a model that never responds — the DeepSeek case", async () => {
    // Listed, priced, advertising `tools`, and every completion hangs with no
    // status. This is why the probe exists: without it the model ships and stalls
    // an agent run indefinitely.
    const hangs = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted.");
          e.name = "AbortError";
          reject(e);
        });
      })) as unknown as typeof fetch;

    const outcome = await probeModel("org/Hangs", KEY, hangs, 25);
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("timeout");
  });

  it("rejects on a non-2xx and carries the status", async () => {
    const outcome = await probeModel("org/Gone", KEY, fetchReturning({}, { ok: false, status: 404 }));
    expect(outcome.ok).toBe(false);
    expect((outcome as { reason: string }).reason).toBe("http_error");
  });

  it("returns an outcome rather than throwing, so one bad model can't fail the sync", async () => {
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const outcome = await probeModel("org/Broken", KEY, boom);
    expect(outcome.ok).toBe(false);
    expect((outcome as { detail?: string }).detail).toContain("ECONNRESET");
  });
});
