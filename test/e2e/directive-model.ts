/**
 * The end-to-end suite's model: deterministic, and steered by the message it is sent.
 *
 * A scenario puts a directive in a user message (`directive()` below writes
 * one); the model reads it from the latest user message and plays it: one round
 * of tool calls per step, then a closing reply. A message with no directive is
 * echoed, with a line per file part, so a scenario can see what reached the
 * model (an attachment's text, an image's bytes).
 *
 * The directive travels as one base64url token, so it survives every
 * containment and escaping the runtime applies to a message or a task body.
 */

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/** One tool call a step makes. Strings in `args` may hold `{{timezone}}`. */
export interface DirectiveCall {
  tool: string;
  args: Record<string, unknown>;
}

/** What a scenario asks the model to do in one turn. */
export interface Directive {
  /** Rounds of tool calls, in order; each round's results arrive before the next. */
  steps?: DirectiveCall[][];
  /** The closing text. Default `"done"`. */
  reply?: string;
  /** Append every round's tool results, as JSON, to the closing text. */
  echoResults?: boolean;
  /** Stream the closing text over this many ms, in `chunks` deltas, honouring an abort. */
  delayMs?: number;
  chunks?: number;
  /** The usage each model call reports. */
  usage?: { input?: number; output?: number };
}

const MARK = "E2E:";
const TOKEN_RE = /E2E:([A-Za-z0-9_-]+)/;

/** A directive as message text. */
export function directive(d: Directive): string {
  return `${MARK}${Buffer.from(JSON.stringify(d)).toString("base64url")}`;
}

/** The system prompt the runtime writes a conversation's title with. */
const TITLE_PROMPT_PREFIX = "Generate a 3-6 word title";
export const E2E_TITLE = "E2E Conversation";

/** What a tool's answer says when it was held for its guidance and ran nothing. */
const HELD_FOR_GUIDANCE = "governed by guidance";

function isTitleCall(options: LanguageModelV4CallOptions): boolean {
  const system = options.prompt.find((m) => m.role === "system");
  return typeof system?.content === "string" && system.content.startsWith(TITLE_PROMPT_PREFIX);
}

function systemText(prompt: LanguageModelV4Prompt): string {
  return prompt
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}

function lastUserIndex(prompt: LanguageModelV4Prompt): number {
  for (let i = prompt.length - 1; i >= 0; i--) if (prompt[i]?.role === "user") return i;
  return -1;
}

/** Every text part of a message, the runtime's `<runtime-context>` head included. */
function textParts(message: LanguageModelV4Prompt[number] | undefined): string[] {
  if (!message || message.role === "system" || !Array.isArray(message.content)) return [];
  const out: string[] = [];
  for (const part of message.content) if (part.type === "text") out.push(part.text);
  return out;
}

function readDirective(prompt: LanguageModelV4Prompt, userAt: number): Directive | null {
  for (const text of textParts(prompt[userAt])) {
    const m = TOKEN_RE.exec(text);
    if (!m?.[1]) continue;
    try {
      return JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as Directive;
    } catch {
      return null;
    }
  }
  return null;
}

/** A tool result's payload, parsed where it is JSON text. */
function resultValue(output: unknown): unknown {
  const out = output as { type?: string; value?: unknown } | undefined;
  const value = out && "value" in out ? out.value : output;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

interface Round {
  results: unknown[];
  held: boolean;
}

/** The tool rounds since the directive's message, each with its parsed results. */
function rounds(prompt: LanguageModelV4Prompt, userAt: number): Round[] {
  const out: Round[] = [];
  for (const message of prompt.slice(userAt + 1)) {
    if (message.role !== "tool") continue;
    const results: unknown[] = [];
    let held = true;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const value = resultValue(part.output);
      results.push(value);
      if (!JSON.stringify(value ?? null).includes(HELD_FOR_GUIDANCE)) held = false;
    }
    out.push({ results, held: held && results.length > 0 });
  }
  return out;
}

/** Fill `{{timezone}}` placeholders from the system prompt's `Timezone:` line. */
function fill(value: unknown, system: string): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\{\{timezone\}\}/g,
      () => /Timezone: ([^\n]+)/.exec(system)?.[1]?.trim() ?? "",
    );
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, system));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, system)]));
  }
  return value;
}

type Planned =
  | { kind: "calls"; calls: Array<{ id: string; tool: string; input: string }> }
  | { kind: "text"; text: string; delayMs: number; chunks: number };

/** A message with no directive, echoed: its text, then a line per file part. */
function echo(prompt: LanguageModelV4Prompt, userAt: number): string {
  const message = prompt[userAt];
  if (message?.role !== "user") return "[echo]";
  const lines: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      if (!part.text.startsWith("<runtime-context>")) lines.push(part.text);
    } else if (part.type === "file") {
      const data = part.data;
      const bytes =
        data.type !== "data"
          ? -1
          : typeof data.data === "string"
            ? Buffer.from(data.data, "base64").byteLength
            : data.data.byteLength;
      lines.push(`[file mediaType=${part.mediaType} bytes=${bytes}]`);
    }
  }
  return lines.join("\n") || "[echo]";
}

function plan(options: LanguageModelV4CallOptions): {
  planned: Planned;
  usage: Directive["usage"];
} {
  const prompt = options.prompt;
  const userAt = lastUserIndex(prompt);
  const d = readDirective(prompt, userAt);
  if (!d)
    return {
      planned: { kind: "text", text: echo(prompt, userAt), delayMs: 0, chunks: 1 },
      usage: undefined,
    };
  const done = rounds(prompt, userAt);
  const advanced = done.filter((r) => !r.held);
  const last = done.at(-1);
  const steps = d.steps ?? [];
  // A round held for guidance ran nothing: the same step again, as a model would.
  const index = advanced.length;
  const step = steps[index];
  if (step) {
    const system = systemText(prompt);
    const salt = `${userAt}-${done.length}${last?.held ? "h" : ""}`;
    return {
      planned: {
        kind: "calls",
        calls: step.map((c, i) => ({
          id: `e2e-${salt}-${i}`,
          tool: c.tool,
          input: JSON.stringify(fill(c.args, system)),
        })),
      },
      usage: d.usage,
    };
  }
  let text = d.reply ?? "done";
  if (d.echoResults) text += `\nRESULTS:${JSON.stringify(advanced.map((r) => r.results))}`;
  return {
    planned: { kind: "text", text, delayMs: d.delayMs ?? 0, chunks: Math.max(1, d.chunks ?? 1) },
    usage: d.usage,
  };
}

function usageOf(usage: Directive["usage"], textLen: number): LanguageModelV4Usage {
  const input = usage?.input ?? 10;
  const output = usage?.output ?? Math.max(1, textLen);
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function split(text: string, chunks: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / chunks));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [""];
}

/** The suite's model. */
export function createDirectiveModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "e2e",
    modelId: "directive-1",
    supportedUrls: {},

    async doGenerate(options) {
      if (isTitleCall(options)) {
        return {
          content: [{ type: "text", text: E2E_TITLE }],
          finishReason: { unified: "stop", raw: undefined },
          usage: usageOf(undefined, E2E_TITLE.length),
          warnings: [],
        };
      }
      const { planned, usage } = plan(options);
      if (planned.kind === "calls") {
        return {
          content: planned.calls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: c.tool,
            input: c.input,
          })),
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: usageOf(usage, 0),
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: planned.text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: usageOf(usage, planned.text.length),
        warnings: [],
      };
    },

    async doStream(options) {
      const { planned, usage } = plan(options);
      const signal = options.abortSignal;
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (planned.kind === "calls") {
            for (const c of planned.calls) {
              controller.enqueue({ type: "tool-input-start", id: c.id, toolName: c.tool });
              controller.enqueue({ type: "tool-input-delta", id: c.id, delta: c.input });
              controller.enqueue({ type: "tool-input-end", id: c.id });
              controller.enqueue({
                type: "tool-call",
                toolCallId: c.id,
                toolName: c.tool,
                input: c.input,
              });
            }
            controller.enqueue({
              type: "finish",
              usage: usageOf(usage, 0),
              finishReason: { unified: "tool-calls", raw: undefined },
            });
            controller.close();
            return;
          }
          const pieces = split(planned.text, planned.chunks);
          const pause = planned.delayMs / pieces.length;
          controller.enqueue({ type: "text-start", id: "text-0" });
          for (const piece of pieces) {
            if (pause > 0) await Bun.sleep(pause);
            if (signal?.aborted) {
              controller.error(signal.reason ?? new Error("aborted"));
              return;
            }
            controller.enqueue({ type: "text-delta", id: "text-0", delta: piece });
          }
          controller.enqueue({ type: "text-end", id: "text-0" });
          controller.enqueue({
            type: "finish",
            usage: usageOf(usage, planned.text.length),
            finishReason: { unified: "stop", raw: undefined },
          });
          controller.close();
        },
      });
      return { stream };
    },
  };
}
