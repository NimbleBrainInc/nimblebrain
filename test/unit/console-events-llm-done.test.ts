import { describe, expect, it, spyOn } from "bun:test";
import { ConsoleEventSink } from "../../src/adapters/console-events.ts";

/** Capture the console channel the sink writes to. */
function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

function emitLlmDone(data: Record<string, unknown>): string {
  const { lines, restore } = captureLines();
  try {
    new ConsoleEventSink().emit({ type: "llm.done", data });
  } finally {
    restore();
  }
  return lines.find((l) => l.includes("[engine] llm.done")) ?? "";
}

// This line is the per-call ground truth an operator reads during triage, and
// the alert runbook documents its field order. A change here is a change to
// documented on-call guidance, not just to a log string.
describe("llm.done console line", () => {
  it("appends the pre-flight estimate alongside the provider's actual input count", () => {
    const line = emitLlmDone({
      model: "anthropic:claude-sonnet-5",
      usage: { inputTokens: 800_000, outputTokens: 1_071 },
      llmMs: 13_270,
      ttftMs: 2_658,
      estimatedInputTokens: 500_000,
    });

    expect(line).toContain("800000 in");
    expect(line).toContain("500000 est");
    // Estimate trails the existing fields so anything parsing the earlier
    // positions is unaffected.
    expect(line.indexOf("est")).toBeGreaterThan(line.indexOf("ttft"));
  });

  it("omits the estimate when the engine did not record one", () => {
    const line = emitLlmDone({
      model: "anthropic:claude-sonnet-5",
      usage: { inputTokens: 800_000, outputTokens: 1_071 },
      llmMs: 13_270,
    });

    expect(line).toContain("800000 in");
    expect(line).not.toContain("est");
    expect(line).not.toContain("NaN");
  });
});
