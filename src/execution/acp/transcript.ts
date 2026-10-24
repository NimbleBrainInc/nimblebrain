/**
 * The door's prompt and history, as prompt content any ACP agent can read.
 *
 * ACP v1 gives a client no slot for a system prompt or for history the agent
 * did not produce. Without a driver that delivers them some better way, they
 * travel in the turn's first prompt, contained, ahead of the latest message.
 * The agent reads them as user content, not as its own instructions, which is
 * weaker than a system prompt and the reason a driver should do better.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { wrapContained } from "../../prompt/compose.ts";
import type { ResolvedRun } from "../types.ts";
import { userMessageToPrompt } from "./nimblebrain-extension.ts";

export function transcriptPrompt(run: ResolvedRun): ContentBlock[] {
  const latest = run.messages.at(-1);
  const prior = latest?.role === "user" ? run.messages.slice(0, -1) : run.messages;
  const context = [wrapContained("host-instructions", run.system)];
  const history = transcriptOf(prior);
  if (history) context.push(wrapContained("conversation-history", history));
  return [
    { type: "text", text: context.join("\n\n") },
    ...(latest?.role === "user" ? userMessageToPrompt(latest) : []),
  ];
}

/** Each message as labelled lines; tool results by name, binary parts by type. */
export function transcriptOf(messages: LanguageModelV4Message[]): string {
  return messages.flatMap(linesOf).join("\n");
}

function linesOf(m: LanguageModelV4Message): string[] {
  switch (m.role) {
    case "system":
      return [];
    case "tool":
      return m.content.flatMap((part) =>
        part.type === "tool-result"
          ? [`Tool result (${part.toolName}): ${resultText(part.output)}`]
          : [],
      );
    case "user":
      return m.content.flatMap((part) => partLine("User", part));
    case "assistant":
      return m.content.flatMap((part) => partLine("Assistant", part));
  }
}

type ContentPart = Exclude<LanguageModelV4Message, { role: "system" | "tool" }>["content"][number];

function partLine(label: string, part: ContentPart): string[] {
  switch (part.type) {
    case "text":
      return [`${label}: ${part.text}`];
    case "tool-call":
      return [`${label} called ${part.toolName} with ${JSON.stringify(part.input)}`];
    case "file":
      return [`${label} attached a ${part.mediaType} file`];
    default:
      return [];
  }
}

type ToolResultOutput = Extract<
  Extract<LanguageModelV4Message, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>["output"];

function resultText(out: ToolResultOutput): string {
  return out.type === "text" || out.type === "error-text" ? out.value : JSON.stringify(out);
}
