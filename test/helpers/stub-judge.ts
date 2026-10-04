/**
 * An in-process MCP judge server for tests: `judge` and `list_judges` in the
 * judge tool contract's shapes, answering from a script the test sets.
 *
 * Each `judge` call is recorded (its arguments) and answered by `answer`,
 * which gets the call and returns either a contract output or an error code,
 * returned the way a judge server returns one: `isError` with
 * `structuredContent.error = { code, message, retryable }`.
 */

import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { ToolResult } from "../../src/engine/types.ts";
import { defineInProcessApp } from "../../src/tools/in-process-app.ts";
import type { McpSource } from "../../src/tools/mcp-source.ts";

export interface StubJudgeCall {
  criteria: Array<Record<string, unknown>>;
  state: { input?: unknown; deliverable: unknown; activity?: unknown[] };
  judge?: { id: string; options?: Record<string, unknown> };
}

export interface StubJudgeOutput {
  judge: { id: string; version?: string; calibrated: boolean };
  answers: Array<{
    id: string;
    answer: boolean | number | string;
    probabilities?: Record<string, number>;
    confidence: number;
    rationale?: string;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type StubJudgeAnswer = StubJudgeOutput | { error: string } | { malformed: unknown };

export interface StubJudge {
  source: McpSource;
  calls: StubJudgeCall[];
  /** Replace the answer for subsequent calls. */
  answer: (call: StubJudgeCall) => StubJudgeAnswer;
}

const RETRYABLE = new Set(["rate_limited", "upstream_unavailable", "upstream_timeout"]);

/** Answer every criterion of a call with `answer` at `confidence`. */
export function answerAll(
  call: StubJudgeCall,
  answer: boolean | number | string,
  confidence = 0.95,
): StubJudgeOutput {
  return {
    judge: { id: "stub", version: "stub-1.0.0", calibrated: true },
    answers: call.criteria.map((c) => ({
      id: String(c.id),
      answer,
      confidence,
      rationale: `stub said ${String(answer)}`,
    })),
    usage: { input_tokens: 100, output_tokens: 5 },
  };
}

/** A started stub judge source named `name`. */
export async function createStubJudge(name = "judge"): Promise<StubJudge> {
  const stub: StubJudge = {
    source: undefined as unknown as McpSource,
    calls: [],
    answer: (call) => answerAll(call, true),
  };
  const judgeTool = async (input: Record<string, unknown>): Promise<ToolResult> => {
    const call = input as unknown as StubJudgeCall;
    stub.calls.push(call);
    const out = stub.answer(call);
    if ("error" in out) {
      return {
        content: textContent(`judge error: ${out.error}`),
        structuredContent: {
          error: { code: out.error, message: "stub error", retryable: RETRYABLE.has(out.error) },
        },
        isError: true,
      };
    }
    if ("malformed" in out) {
      return {
        content: textContent("malformed"),
        structuredContent: out.malformed as Record<string, unknown>,
        isError: false,
      };
    }
    return {
      content: textContent(JSON.stringify(out)),
      structuredContent: out as unknown as Record<string, unknown>,
      isError: false,
    };
  };
  stub.source = defineInProcessApp(
    {
      name,
      version: "1.0.0",
      tools: [
        {
          name: "judge",
          description: "Answer typed criteria about a deliverable.",
          inputSchema: {
            type: "object",
            properties: {
              criteria: { type: "array", items: { type: "object", properties: {} } },
              state: { type: "object", properties: {} },
              judge: { type: "object", properties: {} },
            },
            required: ["criteria", "state"],
          },
          handler: judgeTool,
        },
        {
          name: "list_judges",
          description: "The judges offered.",
          inputSchema: { type: "object", properties: {} },
          handler: async () => {
            const out = {
              judges: [
                {
                  id: "stub",
                  title: "Stub",
                  description: "A test judge",
                  default: true,
                  criterion_types: ["boolean", "score", "choice"],
                  calibrated: true,
                  options_schema: { type: "object" },
                },
              ],
            };
            return {
              content: textContent(JSON.stringify(out)),
              structuredContent: out,
              isError: false,
            };
          },
        },
      ],
    },
    new NoopEventSink(),
  );
  await stub.source.start();
  return stub;
}
