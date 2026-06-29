/**
 * Cross-workspace resume → file-TOOL partition.
 *
 * Sibling to `cross-workspace-file-resume.test.ts`, which pins the *rehydration*
 * read (the `files://` attachment the runtime inlines into the prompt). This one
 * pins the other half: the agent's identity-door `files__*` TOOLS. When the model
 * calls `files__list` during a cross-workspace resume, the tool resolves its
 * workspace-owned store from `RequestContext.fileWorkspaceId`, which `chat()` sets
 * to the conversation's authoritative workspace (`convWsId`) — NOT the request
 * header / personal workspace. So a tool call on an UNFOCUSED resume reads the
 * conversation's workspace (A), where the file lives, and finds it.
 *
 * The rehydration test never invokes a file tool, so it cannot catch a regression
 * in this path (e.g. `fileWorkspaceId` reverting to `request.workspaceId ??
 * sessionWsId`, or the identity-tool-router dropping `fileWorkspaceId` from its
 * per-call restamp). This test exercises the tool directly.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { FileStore } from "../../../src/files/store.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { personalWorkspaceIdFor } from "../../../src/workspace/workspace-store.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nb-cross-workspace-file-tool-resume-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// The conversation's workspace (a focused workspace, the chat is born here).
const WORKSPACE_A = "ws_workspace_a";
// Dev mode: no identity on the request → the dev owner.
const OWNER = DEV_IDENTITY.id;
// The resume is UNFOCUSED → it falls back to the owner's personal workspace,
// a DIFFERENT workspace than WORKSPACE_A. That is the cross-workspace hop.
const PERSONAL = personalWorkspaceIdFor(OWNER);

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
function createResumeFileToolModel(): LanguageModelV3 {
  const echo = createEchoModel();
  const toolModel = createEchoModel({
    responses: [
      { toolCalls: [{ toolCallId: "call_files_list", toolName: "files__list", input: "{}" }] },
      { text: "here are your files" },
    ],
  });

  function lastUserText(opts: LanguageModelV3CallOptions): string {
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

  const pick = (opts: LanguageModelV3CallOptions): LanguageModelV3 =>
    lastUserText(opts) === RESUME_MSG ? toolModel : echo;

  return {
    specificationVersion: "v3",
    provider: "echo",
    modelId: "echo-1",
    supportedUrls: {},
    doGenerate: (opts) => pick(opts).doGenerate(opts),
    doStream: (opts) => pick(opts).doStream(opts),
  };
}

describe("cross-workspace resume scopes the file TOOL to the conversation's workspace (not the request)", () => {
  it("files__list on an UNFOCUSED resume reads workspace A's partition and finds the attachment", async () => {
    const workDir = join(testDir, "file-tool-from-workspace");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createResumeFileToolModel() },
      noDefaultBundles: true,
      logging: { disabled: true },
      workDir,
    });
    await provisionTestWorkspace(runtime, WORKSPACE_A);

    // 1) Born in workspace A (focused on WORKSPACE_A).
    const born = await runtime.chat({ message: "hello from workspace A", workspaceId: WORKSPACE_A });
    const convId = born.conversationId;

    // 2) Attach a file into workspace A's partition (the conversation's workspace).
    const fileStoreA = runtime.getWorkspaceFileStore(WORKSPACE_A, OWNER);
    const saved = await fileStoreA.saveFile(Buffer.from("workspace-A bytes"), "attach.txt", "text/plain");
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

    // Sanity: the personal workspace — where an un-fixed resume would scope the
    // file tool — does NOT hold the file. So a `files__list` that returns it can
    // only have resolved to workspace A.
    expect(await runtime.getWorkspaceFileStore(PERSONAL, OWNER).findEntry(saved.id)).toBeNull();

    // 3) Spy on getWorkspaceFileStore to capture every partition the resume
    //    touches — including the one the `files__list` tool resolves via
    //    RequestContext.fileWorkspaceId.
    const calls: Array<{ wsId: string; store: FileStore }> = [];
    const origGetFileStore = runtime.getWorkspaceFileStore.bind(runtime);
    runtime.getWorkspaceFileStore = (wsId: string, ownerId: string): FileStore => {
      const store = origGetFileStore(wsId, ownerId);
      calls.push({ wsId, store });
      return store;
    };

    // 4) Cross-workspace resume: UNFOCUSED (no workspaceId) → the request
    //    workspace is the owner's personal workspace, NOT workspace A. The model
    //    emits a `files__list` tool call; its store must resolve to A.
    const result = await runtime.chat({ message: RESUME_MSG, conversationId: convId });

    runtime.getWorkspaceFileStore = origGetFileStore;

    // The file tool actually ran and succeeded — it did not throw
    // "no workspace in scope" and did not fail closed.
    const listCall = result.toolCalls.find((c) => c.name === "files__list");
    expect(listCall).toBeDefined();
    expect(listCall?.ok).toBe(true);

    // And it read A's partition: the listing contains the attachment that only
    // exists in workspace A. (Reverting the fix scopes it to PERSONAL, where the
    // file does not exist, so `total` is 0 and this fails.)
    expect(listCall?.output).toContain(saved.id);
    expect(listCall?.output).toContain("attach.txt");
    expect(listCall?.output).toContain('"total": 1');

    // Every partition the resume touched is the conversation's workspace (A) —
    // never the request's personal workspace. This covers the rehydration store
    // AND the file-tool store, both of which must follow `convWsId`.
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.wsId).toBe(WORKSPACE_A);
      expect(c.wsId).not.toBe(PERSONAL);
    }

    await runtime.shutdown();
  });
});
