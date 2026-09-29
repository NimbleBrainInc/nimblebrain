/**
 * Resume → file-TOOL partition.
 *
 * Sibling to `resume-file-rehydration.test.ts`, which pins the *rehydration*
 * read (the `files://` attachment the runtime inlines into the prompt). This one
 * pins the other half: the agent's identity-door `files__*` TOOLS. When the model
 * calls `files__list` during a resume, the tool resolves its workspace-owned
 * store from `RequestContext.workspaceId`, which `chat()` sets to the workspace
 * the turn runs in — the one its request names, which for a resume is the
 * conversation's own (a resume naming any other is refused). So the tool reads
 * the conversation's workspace (A), where the file lives, and finds it.
 *
 * The rehydration test never invokes a file tool, so it cannot catch a regression
 * in this path (e.g. the identity-tool-router dropping `workspaceId` from its
 * per-call restamp). This test exercises the tool directly.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { FileStore } from "../../../src/files/store.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { ConversationNotFoundError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider, devWorkspace } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-resume-file-tool-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// The conversation's workspace (a focused workspace, the chat is born here).
const WORKSPACE_A = "ws_workspace_a";
// Dev mode: no identity on the request → the dev owner.
const OWNER = DEV_IDENTITY.id;
// Another workspace the owner belongs to, provisioned before WORKSPACE_A so it
// is the owner's default: a dev-mode request that names no workspace runs here.
const HOME = "ws_home";

// The resume message — distinct from the born message so the model adapter can
// tell the two turns apart and only emit the tool call on the resume.
const RESUME_MSG = "list my files on resume";

/**
 * A model that echoes by default, but when the user's authored text is
 * `RESUME_MSG` emits a `files__list` tool call (then concludes). The queue is
 * isolated to the resume turns so async auto-title generation on the born chat
 * (which calls the model on a separate prompt) can't consume the scripted
 * tool-call response and make the test flaky.
 */
function createResumeFileToolModel(): LanguageModelV4 {
  const echo = createEchoModel();
  const toolModel = createEchoModel({
    responses: [
      { toolCalls: [{ toolCallId: "call_files_list", toolName: "files__list", input: "{}" }] },
      { text: "here are your files" },
    ],
  });

  function lastUserText(opts: LanguageModelV4CallOptions): string {
    for (let i = opts.prompt.length - 1; i >= 0; i--) {
      const msg = opts.prompt[i];
      if (msg.role === "user") {
        for (const part of msg.content) {
          if (part.type === "text" && !part.text.startsWith("<runtime-context>")) return part.text;
        }
      }
    }
    return "";
  }

  const pick = (opts: LanguageModelV4CallOptions): LanguageModelV4 =>
    lastUserText(opts) === RESUME_MSG ? toolModel : echo;

  return {
    specificationVersion: "v4",
    provider: "echo",
    modelId: "echo-1",
    supportedUrls: {},
    doGenerate: (opts) => pick(opts).doGenerate(opts),
    doStream: (opts) => pick(opts).doStream(opts),
  };
}

describe("a resume scopes the file TOOL to the workspace it runs in", () => {
  it("files__list on a resume in A reads A's partition, and an UNFOCUSED resume is refused", async () => {
    const workDir = join(testDir, "file-tool-from-workspace");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      identityProvider: devProvider,
      model: { provider: "custom", adapter: createResumeFileToolModel() },
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, HOME, "Home");
    await provisionTestWorkspace(runtime, WORKSPACE_A);

    // 1) Born in workspace A (focused on WORKSPACE_A).
    const born = await runtime.chat({
      identity: DEV_IDENTITY,
      message: "hello from workspace A",
      workspaceId: WORKSPACE_A,
    });
    const convId = born.conversationId;

    // 2) Attach a file into workspace A's partition (the conversation's workspace).
    const fileStoreA = runtime.getWorkspaceFileStore(WORKSPACE_A, OWNER);
    const saved = await fileStoreA.saveFile(
      Buffer.from("workspace-A bytes"),
      "attach.txt",
      "text/plain",
    );
    await fileStoreA.appendRegistry({
      id: saved.id,
      filename: "attach.txt",
      mimeType: "text/plain",
      size: saved.size,
      tags: [],
      source: "chat",
      conversationId: convId,
      createdAt: new Date().toISOString(),
      description: null,
      workspaceId: WORKSPACE_A,
      ownerId: OWNER,
      visibility: "private",
    });

    // Sanity: the default workspace does NOT hold the file. So a `files__list` that returns it can
    // only have resolved to workspace A.
    expect(await runtime.getWorkspaceFileStore(HOME, OWNER).findEntry(saved.id)).toBeNull();

    // 3) Spy on getWorkspaceFileStore to capture every partition the resume
    //    touches — including the one the `files__list` tool resolves via
    //    RequestContext.workspaceId.
    const calls: Array<{ wsId: string; store: FileStore }> = [];
    const origGetFileStore = runtime.getWorkspaceFileStore.bind(runtime);
    runtime.getWorkspaceFileStore = (wsId: string, ownerId: string): FileStore => {
      const store = origGetFileStore(wsId, ownerId);
      calls.push({ wsId, store });
      return store;
    };

    // 4) A resume from the owner's default workspace (HOME) is refused
    //    before the model runs, so no file tool is ever scoped to HOME.
    await expect(
      runtime.chat({
        identity: DEV_IDENTITY,
        message: RESUME_MSG,
        conversationId: convId,
        workspaceId: await devWorkspace(runtime),
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(calls).toEqual([]);

    // 5) The resume in A: the model emits a `files__list` tool call; its store
    //    resolves to A.
    const result = await runtime.chat({
      identity: DEV_IDENTITY,
      message: RESUME_MSG,
      conversationId: convId,
      workspaceId: WORKSPACE_A,
    });

    runtime.getWorkspaceFileStore = origGetFileStore;

    // The file tool actually ran and succeeded — it did not throw
    // "no workspace in scope" and did not fail closed.
    const listCall = result.toolCalls.find((c) => c.name === "files__list");
    expect(listCall).toBeDefined();
    expect(listCall?.ok).toBe(true);

    // And it read A's partition: the listing contains the attachment that only
    // exists in workspace A.
    expect(listCall?.output).toContain(saved.id);
    expect(listCall?.output).toContain("attach.txt");
    expect(listCall?.output).toContain('"total": 1');

    // Every partition the resume touched is the conversation's workspace (A).
    // This covers the rehydration store AND the file-tool store.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.wsId).toBe(WORKSPACE_A);
      expect(c.wsId).not.toBe(HOME);
    }

    await runtime.shutdown();
  });
});
