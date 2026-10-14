import { describe, expect, it, spyOn } from "bun:test";
import { ConsoleEventSink } from "../../src/adapters/console-events.ts";
import type { ToolDonePayload } from "../../src/engine/schemas/events.ts";
import { engineEvent, toolDonePayload } from "../helpers/engine-events.ts";

function emitToolDone(overrides: Partial<ToolDonePayload>): string {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    new ConsoleEventSink().emit(engineEvent("tool.done", toolDonePayload(overrides)));
  } finally {
    spy.mockRestore();
  }
  return lines.find((l) => l.includes("[engine] tool.done")) ?? "";
}

// Log queries match `tool.done: <name> (ok|error, Nms)`; the size is appended
// after it so those queries keep matching.
const EXISTING_SHAPE = /tool\.done: (\S+) \((ok|error), (\d+)ms\)/;

describe("tool.done console line", () => {
  it("keeps the name, status and duration, then appends the result size", () => {
    const line = emitToolDone({ name: "crm__get_contact", ms: 41.6, output: "x".repeat(1234) });
    expect(line).toMatch(EXISTING_SHAPE);
    expect(line.match(EXISTING_SHAPE)?.slice(1)).toEqual(["crm__get_contact", "ok", "42"]);
    expect(line.endsWith("(ok, 42ms) 1234 chars")).toBe(true);
  });

  it("adds what the model saw when bounding cut the result", () => {
    const line = emitToolDone({
      ok: false,
      output: "y".repeat(80_000),
      modelOutput: "y".repeat(50_200),
    });
    expect(line).toMatch(EXISTING_SHAPE);
    expect(line.endsWith("(error, 0ms) 80000 chars, 50200 to model")).toBe(true);
  });
});
