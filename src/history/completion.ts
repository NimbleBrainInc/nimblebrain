/**
 * The door's own model work (a conversation's title, a history fold's summary)
 * as one narrow call: a system prompt and one user text, answered with text.
 *
 * The door decides that this work happens; who executes it is the same
 * question as for a turn. On the native runtime it is a call to the run's
 * model (`completeWithModel`). On a runtime that brings its own model and
 * access, such as a CLI signed in to a person's subscription, it is a run on
 * that runtime (`Runtime.completeOnRuntime`), because nothing else can spend
 * that access.
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import { type TokenUsage, tokenUsageFromV4 } from "../usage/types.ts";

export interface CompletionRequest {
  system: string;
  text: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface Completion {
  /** The answer's text, untrimmed; empty when the model answered none. */
  text: string;
  usage: TokenUsage;
  /** The model that answered, when it is not the one the caller named. */
  model?: string;
}

export type Complete = (req: CompletionRequest) => Promise<Completion>;

/** One completion from a model, the native runtime's way. */
export function completeWithModel(model: LanguageModelV4): Complete {
  return async ({ system, text, maxOutputTokens, signal }) => {
    const result = await model.doGenerate({
      prompt: [
        { role: "system", content: system },
        { role: "user", content: [{ type: "text", text }] },
      ],
      maxOutputTokens,
      abortSignal: signal,
    });
    const block = result.content.find((b) => b.type === "text");
    return {
      text: block?.type === "text" ? block.text : "",
      usage: tokenUsageFromV4(result.usage),
    };
  };
}
