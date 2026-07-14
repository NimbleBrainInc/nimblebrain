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
 * Without the seal a conversation born in workspace A, resumed while UNFOCUSED,
 * would answer in the OTHER workspace's context — a cross-workspace information
 * leak: the thread shows A's history but the agent's tools, house rules, and
 * self-reported workspace are the personal one's. The unfocused test below fails
 * if resolution reverts to `request.workspaceId`.
 *
 * A resume that is FOCUSED ELSEWHERE (a *present* `X-Workspace-Id` naming a
 * different workspace than the conversation's own) is a separate case: the
 * runtime still never binds to the request workspace, but a present mismatched
 * focus means the client is displaying one workspace while about to resume a
 * conversation from another (a mis-target). That is now rejected by the resume
 * backstop (`ConversationWorkspaceMismatchError`) rather than silently sealed —
 * the second test pins that. So the "answer from elsewhere" seal covers the
 * header-absent (identity-level) path; the header-present-mismatch path is
 * refused outright.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { ConversationWorkspaceMismatchError } from "../../../src/runtime/errors.ts";
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
const PERSONAL_NAME = "Home Workspace";

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

/** What the model saw on a turn: the serialized prompt and the active tool names. */
interface Captured {
  prompt: string;
  tools: string[];
}

/**
 * Echo model that records the full prompt AND the active tool list of any turn
 * whose authored user text is `RESUME_MSG` into `captured`. Keying on the resume
 * message keeps async auto-title generation (a separate model call on the born
 * chat) out of the capture, so the assertion reads exactly the resume turn.
 *
 * Capturing `opts.tools` lets the test assert the workspace tool surface
 * DIRECTLY (the namespaced `ws_<id>-…` names the model can call), not only
 * transitively through the `## Workspace` narration block.
 */
function createCapturingModel(captured: Captured[]): LanguageModelV3 {
  const echo = createEchoModel();
  const record = (opts: LanguageModelV3CallOptions): void => {
    if (lastUserText(opts) !== RESUME_MSG) return;
    captured.push({
      prompt: serializePrompt(opts),
      tools: (opts.tools ?? []).map((t) => t.name),
    });
  };
  return {
    specificationVersion: "v3",
    provider: "echo",
    modelId: "echo-1",
    supportedUrls: {},
    doGenerate: (opts) => {
      record(opts);
      return echo.doGenerate(opts);
    },
    doStream: (opts) => {
      record(opts);
      return echo.doStream(opts);
    },
  };
}

describe("cross-workspace resume scopes the session's workspace to the conversation (not the request)", () => {
  it("an UNFOCUSED resume of a workspace-A conversation tells the model it is in A, not at home", async () => {
    const workDir = join(testDir, "unfocused");
    mkdirSync(workDir, { recursive: true });
    const captured: Captured[] = [];

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
    const turn = captured.at(-1);
    const prompt = turn?.prompt ?? "";

    // The model is told it is in workspace A — the conversation's own workspace.
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain(WORKSPACE_A);
    expect(prompt).toContain(WORKSPACE_A_NAME);
    // Pre-fix, an unfocused resume rendered the identity-level "home" block.
    // Reverting the seal brings that phrasing back and fails here.
    expect(prompt).not.toContain("not in any single workspace");
    expect(prompt).not.toContain(PERSONAL);

    // Direct tool-surface assertion: the workspace-namespaced tools the model can
    // call are workspace A's (`ws_workspace_a-…`), never the unfocused request's
    // personal workspace (`ws_user_…-…`). Independent of the narration block.
    const wsTools = (turn?.tools ?? []).filter((t) => t.startsWith("ws_"));
    expect(wsTools.length).toBeGreaterThan(0);
    expect(wsTools.some((t) => t.startsWith(`${WORKSPACE_A}-`))).toBe(true);
    expect(wsTools.some((t) => t.startsWith(`${PERSONAL}-`))).toBe(false);

    await runtime.shutdown();
  });

  it("REJECTS resuming a workspace-A conversation while FOCUSED on workspace B (mis-target backstop)", async () => {
    const workDir = join(testDir, "cross-focus");
    mkdirSync(workDir, { recursive: true });
    const captured: Captured[] = [];

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

    // The exact reported scenario: the client is focused on B (present, mismatched
    // `X-Workspace-Id`) but resumes the A-conversation. The runtime never binds to
    // the request workspace — so this is not a leak — but a present mismatched
    // focus means the panel is displaying B while about to resume A. The resume
    // backstop rejects it rather than silently sealing to A, so a mis-targeted
    // message can't land in A while the user looks at B; the client re-scopes to a
    // fresh draft in B instead.
    let thrown: unknown;
    try {
      await runtime.chat({
        message: RESUME_MSG,
        conversationId: born.conversationId,
        workspaceId: WORKSPACE_B,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConversationWorkspaceMismatchError);
    expect((thrown as ConversationWorkspaceMismatchError).conversationWorkspaceId).toBe(WORKSPACE_A);
    expect((thrown as ConversationWorkspaceMismatchError).requestWorkspaceId).toBe(WORKSPACE_B);
    // Rejected before the engine ran — the model never saw a turn scoped to B.
    expect(captured.length).toBe(0);

    await runtime.shutdown();
  });

  it("a conversation IN the personal workspace narrates it as a workspace, not 'home'", async () => {
    // A personal workspace is just a workspace (JIT-provisioned at login). A chat
    // born there narrates the personal workspace like any other — it is no longer
    // the silent, unnamed "identity-level home" bridge.
    const workDir = join(testDir, "personal-narrated");
    mkdirSync(workDir, { recursive: true });
    const captured: Captured[] = [];

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createCapturingModel(captured) },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, PERSONAL, PERSONAL_NAME);

    // Born focused on the personal workspace → convWsId === PERSONAL. The
    // capturing model only records the RESUME_MSG turn (see createCapturingModel).
    await runtime.chat({ message: RESUME_MSG, workspaceId: PERSONAL });

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured.at(-1)?.prompt ?? "";

    // Narrated as its own "## Workspace" block (id + name), NOT the old
    // identity-level "home / not in any single workspace" block.
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain(PERSONAL);
    expect(prompt).toContain(PERSONAL_NAME);
    expect(prompt).not.toContain("not in any single workspace");

    await runtime.shutdown();
  });
});
