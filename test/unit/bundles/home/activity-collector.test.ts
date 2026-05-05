import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityCollector } from "../../../../src/bundles/home/src/services/activity-collector.ts";

/**
 * Regression coverage for the home-bundle activity collector's
 * conversation summary derivation.
 *
 * The collector previously read `meta.totalInputTokens` / `totalOutputTokens`
 * directly off line 1 of each JSONL. Once the unification PR removed those
 * fields from `Conversation`, the collector silently reported zero tokens
 * for every conversation — including new ones written post-deploy. This
 * test pins the derive-from-events behavior so it can't regress.
 */

let workDir: string;
let logDir: string;
let conversationsDir: string;

beforeEach(() => {
  workDir = join(tmpdir(), `home-activity-${crypto.randomUUID()}`);
  logDir = join(workDir, "logs");
  conversationsDir = join(workDir, "conversations");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(conversationsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeEventConv(
  id: string,
  ts: string,
  llmResponses: Array<{ inputTokens: number; outputTokens: number }>,
): void {
  const meta = { id, createdAt: ts, updatedAt: ts, title: null, format: "events" };
  const lines = [JSON.stringify(meta)];
  lines.push(
    JSON.stringify({ ts, type: "user.message", content: [{ type: "text", text: "hi" }] }),
  );
  for (const r of llmResponses) {
    lines.push(JSON.stringify({ ts, type: "run.start", runId: "r1", model: "m1" }));
    lines.push(
      JSON.stringify({
        ts,
        type: "llm.response",
        runId: "r1",
        model: "m1",
        content: [{ type: "text", text: "ok" }],
        usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens },
        llmMs: 10,
      }),
    );
    lines.push(
      JSON.stringify({ ts, type: "run.done", runId: "r1", stopReason: "complete", totalMs: 10 }),
    );
  }
  writeFileSync(join(conversationsDir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

function writeLegacyConv(
  id: string,
  ts: string,
  assistantUsage: { inputTokens: number; outputTokens: number; model: string },
): void {
  const meta = { id, createdAt: ts, updatedAt: ts, title: null };
  const userMsg = { role: "user", content: "hi", timestamp: ts };
  const assistantMsg = {
    role: "assistant",
    content: "ok",
    timestamp: ts,
    metadata: {
      model: assistantUsage.model,
      usage: { inputTokens: assistantUsage.inputTokens, outputTokens: assistantUsage.outputTokens },
    },
  };
  writeFileSync(
    join(conversationsDir, `${id}.jsonl`),
    `${JSON.stringify(meta)}\n${JSON.stringify(userMsg)}\n${JSON.stringify(assistantMsg)}\n`,
  );
}

describe("home ActivityCollector — conversation summaries", () => {
  test("derives token totals from event-format llm.response events", async () => {
    const ts = new Date().toISOString();
    writeEventConv("conv_event001", ts, [
      { inputTokens: 100, outputTokens: 50 },
      { inputTokens: 200, outputTokens: 75 },
    ]);

    const collector = new ActivityCollector(logDir, conversationsDir, workDir);
    const result = await collector.collect({ limit: 10 });

    expect(result.conversations).toHaveLength(1);
    const conv = result.conversations[0]!;
    expect(conv.id).toBe("conv_event001");
    // Derived: 100+200 = 300 in, 50+75 = 125 out. Pre-fix: 0/0 because the
    // collector was reading meta.totalInputTokens (no longer written).
    expect(conv.input_tokens).toBe(300);
    expect(conv.output_tokens).toBe(125);
    expect(conv.preview).toBe("hi");
  });

  test("derives token totals from legacy-format StoredMessage.metadata.usage", async () => {
    const ts = new Date().toISOString();
    writeLegacyConv("conv_legacy001", ts, {
      inputTokens: 400,
      outputTokens: 100,
      model: "claude-sonnet-4-5-20250929",
    });

    const collector = new ActivityCollector(logDir, conversationsDir, workDir);
    const result = await collector.collect({ limit: 10 });

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.input_tokens).toBe(400);
    expect(result.conversations[0]!.output_tokens).toBe(100);
    expect(result.conversations[0]!.preview).toBe("hi");
  });

  test("totals roll up correctly across multiple conversations", async () => {
    const ts = new Date().toISOString();
    writeEventConv("conv_a", ts, [{ inputTokens: 100, outputTokens: 50 }]);
    writeEventConv("conv_b", ts, [{ inputTokens: 200, outputTokens: 80 }]);

    const collector = new ActivityCollector(logDir, conversationsDir, workDir);
    const result = await collector.collect({ limit: 10 });

    // ActivityOutput.totals aggregates from the per-conversation summaries.
    expect(result.totals.conversations).toBe(2);
    expect(result.totals.input_tokens).toBe(300);
    expect(result.totals.output_tokens).toBe(130);
  });
});
