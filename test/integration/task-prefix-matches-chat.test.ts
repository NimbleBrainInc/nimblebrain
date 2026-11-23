/**
 * A task run sends the same cached system prefix as a chat in its workspace, so
 * a one-off run reads the prefix a chat already wrote instead of writing its
 * own. The task framing (`TASK_IDENTITY`) still reaches the model: it leads the
 * `<runtime-context>` head on the run's user message.
 *
 * Observable signal: the first model call of each run, captured by
 * `recordingModel` at the provider boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { DEV_IDENTITY } from "../../src/identity/providers/dev.ts";
import { TASK_IDENTITY } from "../../src/prompt/compose.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createMockModel } from "../helpers/mock-model.ts";
import { type RecordedCall, recordingModel } from "../helpers/recording-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-task-prefix-${Date.now()}`);
let runtime: Runtime;
let calls: RecordedCall[];

function systemText(prompt: LanguageModelV4Message[]): string {
  return prompt
    .filter((m) => m.role === "system")
    .map((m) => (m.role === "system" ? m.content : ""))
    .join("\n");
}

function runtimeContext(prompt: LanguageModelV4Message[]): string {
  const last = prompt.findLast((m) => m.role === "user");
  if (!last || !Array.isArray(last.content)) return "";
  const head = last.content.find(
    (p) => p.type === "text" && p.text.startsWith("<runtime-context>"),
  );
  return head?.type === "text" ? head.text : "";
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  const recorder = recordingModel(
    createMockModel(async () => ({ content: [{ type: "text", text: "ok" }] })),
  );
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

describe("a task run's prompt prefix", () => {
  it("equals a chat's tools and system prefix and carries TASK_IDENTITY on the user message", async () => {
    const chatAt = calls.length;
    await runtime.chat({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      message: "Summarize the week.",
    });
    const chat = calls[chatAt];

    const taskAt = calls.length;
    await runtime.executeTask({
      identity: DEV_IDENTITY,
      workspaceId: TEST_WORKSPACE_ID,
      prompt: "Summarize the week.",
      trigger: "schedule",
    });
    const task = calls[taskAt];

    expect(chat).toBeDefined();
    expect(task).toBeDefined();
    if (!chat || !task) return;

    // Tools precede the system prompt in the cached prefix; a run with no
    // `allowedTools` sends the chat's block.
    expect(task.tools).toEqual(chat.tools);
    expect(systemText(task.prompt).length).toBeGreaterThan(0);
    expect(systemText(task.prompt)).toBe(systemText(chat.prompt));
    expect(systemText(task.prompt)).not.toContain(TASK_IDENTITY);

    expect(runtimeContext(task.prompt)).toContain(TASK_IDENTITY);
    expect(runtimeContext(chat.prompt)).not.toContain(TASK_IDENTITY);
  });
});
