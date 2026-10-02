/**
 * Resume → the SESSION'S workspace (tools + briefing + the "## Workspace" block
 * the model reasons with) is the workspace the request names, and a resume may
 * name only the conversation's own.
 *
 * Sibling to the `resume-file-*` tests, which pin the FILE half (rehydration
 * read + `files__*` tool partition). This one pins everything the model reasons
 * with. A conversation born in workspace A and resumed from B (or unfocused, the
 * owner's default workspace) is refused as an unknown conversation before the model
 * runs (ADR-0037): the thread's history and the agent's tools, house rules and
 * self-reported workspace can never come from two workspaces.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { ConversationNotFoundError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider, devWorkspace } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-resume-workspace-context-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

const WORKSPACE_A = "ws_00883d7b29214d57";
const WORKSPACE_A_NAME = "Alpha Workspace";
const WORKSPACE_B = "ws_00894bbc98f921e5";
const WORKSPACE_B_NAME = "Bravo Workspace";
// Another workspace the owner belongs to, provisioned before WORKSPACE_A so it
// is the owner's default: a dev-mode request that names no workspace runs here.
const HOME = "ws_003f694718dd468d";
const HOME_NAME = "Home Workspace";

const RESUME_MSG = "which workspace am I in";

/**
 * Serialize every message part of a turn into one string so we can assert on the
 * full prompt the model receives, regardless of whether the runtime carries the
 * "## Workspace" block as a system message or an injected runtime-context part.
 */
function serializePrompt(opts: LanguageModelV4CallOptions): string {
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

function lastUserText(opts: LanguageModelV4CallOptions): string {
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
function createCapturingModel(captured: Captured[]): LanguageModelV4 {
  const echo = createEchoModel();
  const record = (opts: LanguageModelV4CallOptions): void => {
    if (lastUserText(opts) !== RESUME_MSG) return;
    captured.push({
      prompt: serializePrompt(opts),
      tools: (opts.tools ?? []).map((t) => t.name),
    });
  };
  return {
    specificationVersion: "v4",
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

describe("a resume runs only in the conversation's own workspace", () => {
  it("an UNFOCUSED resume of a workspace-A conversation is refused before the model runs", async () => {
    const workDir = join(testDir, "unfocused");
    mkdirSync(workDir, { recursive: true });
    const captured: Captured[] = [];

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createCapturingModel(captured) },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, HOME, HOME_NAME);
    await provisionTestWorkspace(runtime, WORKSPACE_A, WORKSPACE_A_NAME);

    // Born focused on workspace A → the conversation lives in A.
    const born = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "hello from A",
      workspaceId: WORKSPACE_A,
    });

    // From the owner's default workspace (HOME), where the conversation is not.
    await expect(
      runtime.chat({
        identity: DEV_IDENTITY,
        message: RESUME_MSG,
        conversationId: born.conversationId,
        workspaceId: await devWorkspace(runtime),
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(captured).toEqual([]);

    await runtime.shutdown();
  });

  it("resuming a workspace-A conversation from workspace B is refused; resuming in A tells the model it is in A", async () => {
    const workDir = join(testDir, "cross-focus");
    mkdirSync(workDir, { recursive: true });
    const captured: Captured[] = [];

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createCapturingModel(captured) },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, WORKSPACE_A, WORKSPACE_A_NAME);
    await provisionTestWorkspace(runtime, WORKSPACE_B, WORKSPACE_B_NAME);

    const born = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "hello from A",
      workspaceId: WORKSPACE_A,
    });

    await expect(
      runtime.chat({
        identity: DEV_IDENTITY,
        message: RESUME_MSG,
        conversationId: born.conversationId,
        workspaceId: WORKSPACE_B,
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(captured).toEqual([]);

    await runtime.chat({
      identity: DEV_IDENTITY,
      message: RESUME_MSG,
      conversationId: born.conversationId,
      workspaceId: WORKSPACE_A,
    });

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured.at(-1)?.prompt ?? "";
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain(WORKSPACE_A);
    expect(prompt).toContain(WORKSPACE_A_NAME);
    expect(prompt).not.toContain(WORKSPACE_B);
    expect(prompt).not.toContain(WORKSPACE_B_NAME);
    expect(prompt).not.toContain(HOME);

    await runtime.shutdown();
  });

  it("a conversation IN the default workspace narrates it as a workspace, not 'home'", async () => {
    // The owner's default workspace is just a workspace. A chat born there
    // narrates it like any other — not the silent, unnamed "identity-level
    // home" bridge.
    const workDir = join(testDir, "default-narrated");
    mkdirSync(workDir, { recursive: true });
    const captured: Captured[] = [];

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createCapturingModel(captured) },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, HOME, HOME_NAME);

    // Born focused on the default workspace → convWsId === HOME. The
    // capturing model only records the RESUME_MSG turn (see createCapturingModel).
    await runtime.chat({ identity: DEV_IDENTITY, message: RESUME_MSG, workspaceId: HOME });

    expect(captured.length).toBeGreaterThan(0);
    const prompt = captured.at(-1)?.prompt ?? "";

    // Narrated as its own "## Workspace" block (id + name), NOT the old
    // identity-level "home / not in any single workspace" block.
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain(HOME);
    expect(prompt).toContain(HOME_NAME);
    expect(prompt).not.toContain("not in any single workspace");

    await runtime.shutdown();
  });
});
