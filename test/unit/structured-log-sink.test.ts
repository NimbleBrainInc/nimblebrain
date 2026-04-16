import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StructuredLogSink } from "../../src/adapters/structured-log-sink.ts";

function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), "log-sink-test-"));
}

function readLogRecords(dir: string): Record<string, unknown>[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return [];
  const content = readFileSync(join(dir, files[0]), "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("StructuredLogSink", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = makeLogDir();
  });

  it("writes each event as a separate log line", () => {
    const sink = new StructuredLogSink({ dir: logDir });

    sink.emit({ type: "run.start", data: { runId: "r1", model: "test-model" } });
    sink.emit({
      type: "llm.done",
      data: {
        runId: "r1",
        model: "test-model",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheCreationTokens: 0,
        llmMs: 80,
      },
    });
    sink.emit({
      type: "tool.start",
      data: { runId: "r1", name: "my-tool", id: "call-1" },
    });
    sink.emit({
      type: "tool.done",
      data: { runId: "r1", name: "my-tool", id: "call-1", ok: true, ms: 120 },
    });
    sink.emit({
      type: "run.done",
      data: { runId: "r1", stopReason: "complete", iterations: 1, totalMs: 500 },
    });
    sink.close();

    const records = readLogRecords(logDir);
    expect(records).toHaveLength(5);
    expect(records.map((r) => r.event)).toEqual([
      "run.start",
      "llm.done",
      "tool.start",
      "tool.done",
      "run.done",
    ]);
  });

  it("preserves llm.done fields as-is without accumulation", () => {
    const sink = new StructuredLogSink({ dir: logDir });

    sink.emit({
      type: "llm.done",
      data: {
        runId: "r1",
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheCreationTokens: 100,
        llmMs: 80,
      },
    });
    sink.emit({
      type: "llm.done",
      data: {
        runId: "r1",
        model: "claude-sonnet-4-5-20250929",
        inputTokens: 2000,
        outputTokens: 400,
        cacheReadTokens: 1500,
        cacheCreationTokens: 0,
        llmMs: 120,
      },
    });
    sink.close();

    const records = readLogRecords(logDir);
    const llmRecords = records.filter((r) => r.event === "llm.done");
    expect(llmRecords).toHaveLength(2);

    // Each record has its own per-call values, not accumulated
    expect(llmRecords[0]!.inputTokens).toBe(1000);
    expect(llmRecords[0]!.model).toBe("claude-sonnet-4-5-20250929");
    expect(llmRecords[1]!.inputTokens).toBe(2000);
    expect(llmRecords[1]!.cacheReadTokens).toBe(1500);
  });

  it("run.done is a lightweight bookend with no derived data", () => {
    const sink = new StructuredLogSink({ dir: logDir });

    sink.emit({ type: "run.start", data: { runId: "r1", model: "test-model" } });
    sink.emit({
      type: "llm.done",
      data: { runId: "r1", model: "test-model", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, llmMs: 50 },
    });
    sink.emit({
      type: "run.done",
      data: { runId: "r1", stopReason: "complete", iterations: 1, totalMs: 500 },
    });
    sink.close();

    const records = readLogRecords(logDir);
    const done = records.find((r) => r.event === "run.done");
    expect(done).toBeDefined();
    expect(done!.stopReason).toBe("complete");
    expect(done!.totalMs).toBe(500);

    // No accumulated or derived fields
    expect(done!.costUsd).toBeUndefined();
    expect(done!.llmMs).toBeUndefined();
    expect(done!.toolCalls).toBeUndefined();
    expect(done!.toolStats).toBeUndefined();
    expect(done!.cacheReadTokens).toBeUndefined();
  });

  it("includes conversation ID on all records when set", () => {
    const sink = new StructuredLogSink({ dir: logDir, conversationId: "conv_abc" });

    sink.emit({ type: "run.start", data: { runId: "r1" } });
    sink.emit({
      type: "llm.done",
      data: { runId: "r1", model: "m", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, llmMs: 1 },
    });
    sink.close();

    const records = readLogRecords(logDir);
    for (const r of records) {
      expect(r.sid).toBe("conv_abc");
    }
  });

  it("setConversationId updates sid for subsequent events", () => {
    const sink = new StructuredLogSink({ dir: logDir });

    sink.emit({ type: "run.start", data: { runId: "r1" } });
    sink.setConversationId("conv_xyz");
    sink.emit({
      type: "llm.done",
      data: { runId: "r1", model: "m", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, llmMs: 1 },
    });
    sink.close();

    const records = readLogRecords(logDir);
    expect(records[0]!.sid).toBeUndefined();
    expect(records[1]!.sid).toBe("conv_xyz");
  });

  it("skips text.delta events", () => {
    const sink = new StructuredLogSink({ dir: logDir });
    sink.emit({ type: "text.delta", data: { runId: "r1", text: "hello" } });
    sink.close();

    const records = readLogRecords(logDir);
    expect(records).toHaveLength(0);
  });

  it("excludes noisy fields from log records", () => {
    const sink = new StructuredLogSink({ dir: logDir });
    sink.emit({
      type: "run.start",
      data: {
        runId: "r1",
        model: "test-model",
        toolNames: ["a", "b"],
        systemPromptLength: 5000,
        systemPrompt: "long prompt...",
        messageRoles: ["user"],
        estimatedMessageTokens: 1234,
        toolCount: 2,
      },
    });
    sink.close();

    const records = readLogRecords(logDir);
    expect(records[0]!.model).toBe("test-model");
    expect(records[0]!.toolCount).toBe(2);
    expect(records[0]!.toolNames).toBeUndefined();
    expect(records[0]!.systemPromptLength).toBeUndefined();
    expect(records[0]!.systemPrompt).toBeUndefined();
    expect(records[0]!.messageRoles).toBeUndefined();
    expect(records[0]!.estimatedMessageTokens).toBeUndefined();
  });

  it("concurrent runs produce independent event streams", () => {
    const sink = new StructuredLogSink({ dir: logDir });

    sink.emit({ type: "run.start", data: { runId: "a" } });
    sink.emit({ type: "run.start", data: { runId: "b" } });
    sink.emit({
      type: "llm.done",
      data: { runId: "a", model: "model-a", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, llmMs: 10 },
    });
    sink.emit({
      type: "llm.done",
      data: { runId: "b", model: "model-b", inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheCreationTokens: 0, llmMs: 20 },
    });
    sink.emit({ type: "run.done", data: { runId: "a", stopReason: "complete", iterations: 1, totalMs: 100 } });
    sink.emit({ type: "run.done", data: { runId: "b", stopReason: "complete", iterations: 1, totalMs: 200 } });
    sink.close();

    const records = readLogRecords(logDir);
    const llmA = records.find((r) => r.event === "llm.done" && r.runId === "a");
    const llmB = records.find((r) => r.event === "llm.done" && r.runId === "b");

    expect(llmA!.model).toBe("model-a");
    expect(llmA!.inputTokens).toBe(100);
    expect(llmB!.model).toBe("model-b");
    expect(llmB!.inputTokens).toBe(200);
  });
});
