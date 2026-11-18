/**
 * A conversation keeps what it loaded (ADR-0066), end to end through
 * `runtime.chat()`: the tools block a later turn sends is never smaller than an
 * earlier turn's.
 *
 *  1. A trigger-matched skill's `allowed-tools` stay direct on a later turn whose
 *     message matches nothing (the task-authoring skill and its task tools).
 *  2. A tool the conversation called stays direct on later turns, though it is
 *     not in the hot set.
 *
 * Observable signal: the tool list on each model call, captured by
 * `recordingModel` around a scripted mock.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { type RecordedCall, recordingModel } from "../helpers/recording-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-conversation-carry-${Date.now()}`);
let runtime: Runtime;
let calls: RecordedCall[];

/** The text of the last user message that is not runtime context. */
function lastUserText(prompt: LanguageModelV4Message[]): string {
  const last = prompt.findLast((m) => m.role === "user");
  if (!last || !Array.isArray(last.content)) return "";
  return last.content
    .filter((p) => p.type === "text" && !p.text.startsWith("<runtime-context>"))
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ");
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  // Calls `conversations__list` (proxied: not in the hot set) once when the
  // message asks for it, then answers in text.
  const scripted = createMockModel(async ({ prompt }) => {
    const afterTool = prompt[prompt.length - 1]?.role === "tool";
    if (!afterTool && lastUserText(prompt).includes("list my conversations")) {
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "conversations__list",
            input: "{}",
          },
        ],
        finishReason: "tool-calls",
      };
    }
    return { content: [{ type: "text", text: "ok" }] };
  });
  const recorder = recordingModel(scripted);
  calls = recorder.calls;

  runtime = await Runtime.start({
    identityProvider: devProvider,
    languageModel: recorder.model,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
});

afterAll(async () => {
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/** Tool names on the first model call of the turn `send` runs. */
async function firstCallTools(send: () => Promise<{ conversationId: string }>) {
  const before = calls.length;
  const result = await send();
  return { conversationId: result.conversationId, tools: calls[before]?.tools.map((t) => t.name) };
}

describe("a conversation keeps what it loaded", () => {
  it("keeps a trigger-matched skill's tools on a turn that matches nothing", async () => {
    const first = await firstCallTools(() =>
      runtime.chat({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        message: "Schedule a digest every weekday at 8am.",
      }),
    );
    expect(first.tools).toContain("tasks__create");

    const next = await firstCallTools(() =>
      runtime.chat({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        conversationId: first.conversationId,
        message: "Actually, make it 9am instead.",
      }),
    );
    expect(next.tools).toEqual(first.tools);
  });

  it("keeps a tool the conversation called, appended after the turn's own set", async () => {
    const first = await firstCallTools(() =>
      runtime.chat({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        message: "Please list my conversations.",
      }),
    );
    expect(first.tools).not.toContain("conversations__list");

    const next = await firstCallTools(() =>
      runtime.chat({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        conversationId: first.conversationId,
        message: "Thanks.",
      }),
    );
    expect(next.tools).toEqual([...(first.tools ?? []), "conversations__list"]);
  });

  it("starts a new conversation from the hot set alone", async () => {
    const fresh = await firstCallTools(() =>
      runtime.chat({
        identity: DEV_IDENTITY,
        workspaceId: TEST_WORKSPACE_ID,
        message: "Hello.",
      }),
    );
    expect(fresh.tools).not.toContain("tasks__create");
    expect(fresh.tools).not.toContain("conversations__list");
  });
});
