/**
 * Cross-workspace resume → the SESSION'S workspace (tools + briefing + the
 * "## Workspace" block the model reasons with) follows the conversation's own
 * workspace, NOT the request's focused workspace.
 *
 * Sibling to the `cross-workspace-file-*-resume` tests, which pin the FILE half
 * (rehydration read + `files__*` tool partition) to `convWsId`. This one pins the
 * other half: everything the model reasons with — `toolsWsId`, the workspace
 * briefing, and the "## Workspace" prompt block (the literal answer to "which
 * workspace am I in?"). All of these resolve `convWsId` (the conversation's
 * authoritative workspace), never `request.workspaceId`.
 *
 * Without the seal a conversation born in workspace A, resumed while focused
 * elsewhere (or unfocused), answers in the OTHER workspace's context — a
 * cross-workspace information leak: the thread shows A's history but the agent's
 * tools, house rules, and self-reported workspace are the focused one's. Each
 * assertion below fails if resolution reverts to `request.workspaceId`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-cross-workspace-context-resume-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

const WORKSPACE_A = "ws_workspace_a";
const WORKSPACE_A_NAME = "Alpha Workspace";
const WORKSPACE_B = "ws_workspace_b";
const WORKSPACE_B_NAME = "Bravo Workspace";
const OWNER = DEV_IDENTITY.id;
const PERSONAL = personalWorkspaceIdFor(OWNER);

const RESUME_MSG = "which workspace am I in";

/**
 * Serialize every message part of a turn into one string so we can assert on the
 * full prompt the model receives, regardless of whether the runtime carries the
 * "## Workspace" block as a system message or an injected runtime-context part.
 */
function serializePrompt(opts: LanguageModelV3CallOptions): string {
  const chunks: string[] = [];
  for (const msg of opts.prompt) {
    if (typeof msg.content === "string") {
      chunks.push(msg.content);
      continue;
    }
    for (const part of msg.content) {
      if (part.type === "text") chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

function lastUserText(opts: LanguageModelV3CallOptions): string {
  for (let i = opts.prompt.length - 1; i >= 0; i--) {
    const msg = opts.prompt[i];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && !part.text.startsWith("<runtime-context>")) return part.text;
      }
    }
  }
  return "";
}

/**
 * Echo model that records the full prompt of any turn whose authored user text
 * is `RESUME_MSG` into `captured`. Keying on the resume message keeps async
 * auto-title generation (a separate model call on the born chat) out of the
 * capture, so the assertion reads exactly the resume turn's prompt.
 */
function createCapturingModel(captured: string[]): LanguageModelV3 {
  const echo = createEchoModel();
  return {
    specificationVersion: "v3",
    provider: "echo",
    modelId: "echo-1",
    supportedUrls: {},
    doGenerate: (opts) => {
      if (lastUserText(opts) === RESUME_MSG) captured.push(serializePrompt(opts));
      return echo.doGenerate(opts);
    },
    doStream: (opts) => {
      if (lastUserText(opts) === RESUME_MSG) captured.push(serializePrompt(opts));
      return echo.doStream(opts);
    },
  };
}

describe("cross-workspace resume scopes the session's workspace to the conversation (not the request)", () => {
  it("an UNFOCUSED resume of a workspace-A conversation tells the model it is in A, not at home", async () => {
    const workDir = join(testDir, "unfocused");
    mkdirSync(workDir, { recursive: true });
    const captured: string[] = [];

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createCapturingModel(captured) },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, WORKSPACE_A, WORKSPACE_A_NAME);

    // Born focused on workspace A → the conversation's authoritative workspace is A.
    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });

    // Cross-workspace resume: UNFOCUSED (no workspaceId). The request workspace
    // falls back to the owner's PERSONAL workspace — a different workspace than A.
    await runtime.chat({ message: RESUME_MSG, conversationId: born.conversationId });

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured.at(-1) ?? "";

    // The model is told it is in workspace A — the conversation's own workspace.
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain(WORKSPACE_A);
    expect(prompt).toContain(WORKSPACE_A_NAME);
    // Pre-fix, an unfocused resume rendered the identity-level "home" block.
    // Reverting the seal brings that phrasing back and fails here.
    expect(prompt).not.toContain("not in any single workspace");
    expect(prompt).not.toContain(PERSONAL);

    await runtime.shutdown();
  });

  it("resuming a workspace-A conversation while FOCUSED on workspace B tells the model it is in A, not B", async () => {
    const workDir = join(testDir, "cross-focus");
    mkdirSync(workDir, { recursive: true });
    const captured: string[] = [];

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createCapturingModel(captured) },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, WORKSPACE_A, WORKSPACE_A_NAME);
    await provisionTestWorkspace(runtime, WORKSPACE_B, WORKSPACE_B_NAME);

    // Born in A.
    const born = await runtime.chat({ message: "hello from A", workspaceId: WORKSPACE_A });

    // The exact reported scenario: switch the focused workspace to B, then keep
    // talking in the A-conversation. The seal must answer "A", not "B".
    await runtime.chat({
      message: RESUME_MSG,
      conversationId: born.conversationId,
      workspaceId: WORKSPACE_B,
    });

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured.at(-1) ?? "";

    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain(WORKSPACE_A);
    expect(prompt).toContain(WORKSPACE_A_NAME);
    // The focused workspace (B) must NOT leak into the resumed A-conversation.
    expect(prompt).not.toContain(WORKSPACE_B);
    expect(prompt).not.toContain(WORKSPACE_B_NAME);

    await runtime.shutdown();
  });
});
