import { describe, expect, it } from "bun:test";
import {
  buildNebiusCatalog,
  probeModel,
  type RawNebiusModel,
} from "../../src/model/sync-nebius.ts";

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

  it("uses the real context and caps output at the default, never above context", () => {
    const big = buildNebiusCatalog([raw({ context_length: 1048576 })], curated);
    expect(big["org/Model-A"]!.limits).toEqual({ context: 1048576, output: 16384 });

    // A model whose whole window is below the default output cap must clamp to it.
    const small = buildNebiusCatalog([raw({ context_length: 8000 })], curated);
    expect(small["org/Model-A"]!.limits).toEqual({ context: 8000, output: 8000 });
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

  it("rejects a model that answers in prose instead of calling the tool", async () => {
    // `supported_features: ["tools"]` is a claim; this is the check.
    const prose = { choices: [{ message: { content: "It is sunny in Paris." } }] };
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
