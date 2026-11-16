import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import {
  estimateMessageTokens,
  estimateToolDescriptionTokens,
} from "../../src/engine/token-estimate.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const INPUT_CAP = 40_000;
const MODEL = "anthropic:claude-opus-4-7";

function eventOf<T extends EngineEvent["type"]>(events: EngineEvent[], type: T) {
  const event = events.find((candidate) => candidate.type === type);
  if (!event || event.type !== type) throw new Error(`missing ${type} event`);
  return event;
}

function disjointPromptTokens(events: EngineEvent[]): number {
  const event = eventOf(events, "context.assembled");
  if (event.type !== "context.assembled") throw new Error("missing context snapshot");
  return event.data.sources
    .filter((source) => ["system_prompt", "tool_descriptions", "history"].includes(source.kind))
    .reduce((sum, source) => sum + source.tokens, 0);
}

function sentPromptTokens(options: LanguageModelV4CallOptions): number {
  return (
    options.prompt.reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
    (options.tools ?? []).reduce((sum, tool) => sum + estimateToolDescriptionTokens(tool), 0)
  );
}

test("resumed turns calibrate from the first sent prompt, even after history windowing", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "nimblebrain-calibration-"));
  const turns: EngineEvent[][] = [[], [], []];
  const sentPrompts: LanguageModelV4CallOptions["prompt"][] = [];
  let activeEvents = turns[0]!;
  const model = createMockModel((options) => {
    // Title generation has no tool surface and is not a conversation turn.
    if (!options.tools?.length) {
      return { content: [{ type: "text", text: "Test title" }], inputTokens: 10 };
    }

    const turn = sentPrompts.length;
    sentPrompts.push(options.prompt);
    const actual = Math.ceil(sentPromptTokens(options) * 1.5);
    if (turn !== 0) {
      return { content: [{ type: "text", text: "ok" }], inputTokens: actual };
    }

    const start = eventOf(activeEvents, "run.start");
    const context = eventOf(activeEvents, "context.assembled");
    if (start.type !== "run.start" || context.type !== "context.assembled") {
      throw new Error("missing first-run metadata");
    }
    const overhead = context.data.sources
      .filter((source) => source.kind === "system_prompt" || source.kind === "tool_descriptions")
      .reduce((sum, source) => sum + source.tokens, 0);
    const correctedBudget = Math.max(0, Math.floor(INPUT_CAP / 1.5 - overhead));
    const middleTokens = Math.floor((start.data.maxInputTokens + correctedBudget) / 2) - 500;
    if (middleTokens <= correctedBudget || middleTokens >= start.data.maxInputTokens) {
      throw new Error("test fixture cannot place an assistant turn between the two budgets");
    }
    return {
      content: [{ type: "text", text: `LONG_MIDDLE_${"x".repeat(middleTokens * 4)}` }],
      inputTokens: actual,
      outputTokens: 1,
    };
  });

  const runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: model,
    models: { default: MODEL },
    maxInputTokens: INPUT_CAP,
    features: { compaction: false },
    workDir,
    logging: { disabled: true },
    telemetry: { enabled: false },
  });
  try {
    await provisionTestWorkspace(runtime);
    let conversationId: string | undefined;
    for (let turn = 0; turn < turns.length; turn++) {
      activeEvents = turns[turn]!;
      const sink: EventSink = { emit: (event) => void activeEvents.push(event) };
      const result = await runtime.chat(
        {
          identity: DEV_IDENTITY,
          workspaceId: TEST_WORKSPACE_ID,
          message: `turn ${turn + 1}`,
          ...(conversationId ? { conversationId } : {}),
        },
        sink,
      );
      conversationId = result.conversationId;
    }

    expect(sentPrompts).toHaveLength(3);
    const firstBudget = eventOf(turns[0]!, "run.start");
    const secondBudget = eventOf(turns[1]!, "run.start");
    const thirdBudget = eventOf(turns[2]!, "run.start");
    if (
      firstBudget.type !== "run.start" ||
      secondBudget.type !== "run.start" ||
      thirdBudget.type !== "run.start"
    ) {
      throw new Error("missing run-start budget");
    }
    expect(secondBudget.data.maxInputTokens).toBeLessThan(firstBudget.data.maxInputTokens * 0.8);
    expect(JSON.stringify(sentPrompts[1])).not.toContain("LONG_MIDDLE_");

    const secondResponse = eventOf(turns[1]!, "llm.done");
    if (secondResponse.type !== "llm.done") throw new Error("missing second provider response");
    // If context.assembled includes the dropped middle turn, this ratio
    // collapses below 1 and the third turn silently loses calibration.
    expect(secondResponse.data.usage.inputTokens / disjointPromptTokens(turns[1]!)).toBeGreaterThan(
      1.4,
    );
    expect(thirdBudget.data.maxInputTokens).toBeLessThan(firstBudget.data.maxInputTokens * 0.8);
  } finally {
    await runtime.shutdown();
    rmSync(workDir, { recursive: true, force: true });
  }
});
