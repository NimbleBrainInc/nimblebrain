import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { ModelNotQualifiedError } from "../../../src/model/model-id.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-model-qualification-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

async function startRuntime(
  name: string,
  extra: Partial<Parameters<typeof Runtime.start>[0]> = {},
) {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  return Runtime.start({
    identityProvider: devProvider,
    languageModel: createEchoModel(),
    workDir,
    ...extra,
  });
}

async function runStartModel(runtime: Runtime, model: string | undefined): Promise<unknown> {
  const events: EngineEvent[] = [];
  const sink: EventSink = { emit: (e) => events.push(e) };
  await runtime.chat(
    { identity: DEV_IDENTITY, message: "hello", workspaceId: TEST_WORKSPACE_ID, model },
    sink,
  );
  return events.find((e) => e.type === "run.start")?.data.model;
}

describe("model ids are provider:model at every runtime boundary", () => {
  // The built-in default is what every unset slot resolves to, and it reaches
  // the conversation pin, the ledger and the picker unchanged, so it has to be
  // in the one form those accept.
  it("resolves unset slots to the qualified built-in default", async () => {
    const runtime = await startRuntime("builtin-default");
    try {
      expect(runtime.getModelSlots()).toEqual({
        default: "anthropic:claude-sonnet-4-6",
        fast: "anthropic:claude-sonnet-4-6",
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("refuses a bare request model, naming the qualified form, and starts no run", async () => {
    const runtime = await startRuntime("request-bare");
    await provisionTestWorkspace(runtime);
    try {
      const attempt = runStartModel(runtime, "gemini-3.1-pro-preview");
      await expect(attempt).rejects.toThrow(ModelNotQualifiedError);
      await expect(runStartModel(runtime, "gemini-3.1-pro-preview")).rejects.toThrow(
        '"google:gemini-3.1-pro-preview"',
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("passes a qualified request model through unchanged", async () => {
    const runtime = await startRuntime("request-qualified");
    await provisionTestWorkspace(runtime);
    try {
      expect(await runStartModel(runtime, "google:gemini-3.1-pro-preview")).toBe(
        "google:gemini-3.1-pro-preview",
      );
    } finally {
      await runtime.shutdown();
    }
  });

  // A config handed to `Runtime.start` in code never passes the CLI loader's
  // schema, so the runtime holds the same rule itself.
  it.each([
    [{ models: { default: "claude-sonnet-4-6" } }, 'models.default "claude-sonnet-4-6"'],
    [{ models: { fast: "gpt-4o" } }, 'models.fast "gpt-4o"'],
    [{ modelPolicy: { allowed: ["gpt-4o"] } }, 'modelPolicy.allowed entry "gpt-4o"'],
  ])("refuses to start on a bare configured id (%#)", async (config, subject) => {
    await expect(startRuntime(`start-bare-${subject.length}`, config)).rejects.toThrow(
      `${subject} has no provider`,
    );
  });

  it("resolves both spellings of a slot name on the request door", async () => {
    const runtime = await startRuntime("slot-ref-request-door", {
      models: { default: "anthropic:claude-sonnet-4-6", fast: "openai:gpt-4o" },
    });
    await provisionTestWorkspace(runtime);
    try {
      for (const spelling of ["fast", "alias:fast"]) {
        expect(await runStartModel(runtime, spelling)).toBe("openai:gpt-4o");
      }
    } finally {
      await runtime.shutdown();
    }
  });

  // `workspace.json` has no writer that could refuse a bare override, so the
  // slot read refuses it, naming the file and the form to write.
  it("fails a turn on a bare workspace.json model override", async () => {
    const runtime = await startRuntime("workspace-bare");
    await provisionTestWorkspace(runtime);
    await runtime
      .getWorkspaceStore()
      .update(TEST_WORKSPACE_ID, { models: { default: "claude-sonnet-4-6" } });
    try {
      await expect(runStartModel(runtime, undefined)).rejects.toThrow(
        'workspace.json models.default "claude-sonnet-4-6" has no provider. Write it as provider:model, e.g. "anthropic:claude-sonnet-4-6".',
      );
    } finally {
      await runtime.shutdown();
    }
  });
});
