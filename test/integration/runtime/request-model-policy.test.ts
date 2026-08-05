import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelNotAllowedError } from "../../../src/runtime/errors.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-request-model-policy-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/** A runtime whose anthropic provider allows exactly one model. */
async function startWithAllowlist(name: string, models: string[], slots?: Record<string, string>) {
  const workDir = join(testDir, name);
  mkdirSync(workDir, { recursive: true });
  const runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    providers: { anthropic: { apiKey: "test-key", models } },
    ...(slots ? { models: slots as never } : {}),
    noDefaultBundles: true,
    workDir,
  });
  await provisionTestWorkspace(runtime);
  return runtime;
}

/**
 * The error a chat turn produced, or null if it completed.
 *
 * Assertions here are about whether the gate fired, not whether the turn
 * succeeded: configuring `providers` (which is what carries the allowlist)
 * displaces the echo adapter, so an admitted model still fails downstream
 * against a placeholder key. That failure is not the property under test.
 */
const chatError = (runtime: Runtime, model?: string): Promise<unknown> =>
  runtime
    .chat({
      message: "hi",
      workspaceId: TEST_WORKSPACE_ID,
      ...(model !== undefined ? { model } : {}),
    })
    .then(
      () => null,
      (e) => e,
    );

describe("a caller-supplied model is checked against the allowlist", () => {
  it("refuses a model outside the allowlist", async () => {
    const runtime = await startWithAllowlist("refuses", ["claude-sonnet-4-6"]);
    try {
      expect(await chatError(runtime, "anthropic:claude-opus-4-6")).toBeInstanceOf(
        ModelNotAllowedError,
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("refuses a model whose provider is not configured", async () => {
    const runtime = await startWithAllowlist("no-provider", ["claude-sonnet-4-6"]);
    try {
      expect(await chatError(runtime, "openai:gpt-4o")).toBeInstanceOf(ModelNotAllowedError);
    } finally {
      await runtime.shutdown();
    }
  });

  it("admits a model on the allowlist", async () => {
    const runtime = await startWithAllowlist("admits", ["claude-sonnet-4-6"]);
    try {
      expect(await chatError(runtime, "anthropic:claude-sonnet-4-6")).not.toBeInstanceOf(
        ModelNotAllowedError,
      );
    } finally {
      await runtime.shutdown();
    }
  });

});

describe("operator config is not the caller's input and is not gated", () => {
  // The load-bearing pair. An allowlist is for untrusted input; a slot value
  // and the instance default are the operator's own config, governed where
  // they are written. Gating them here would refuse to serve a deployment
  // whose config predates its allowlist — turning a policy addition into an
  // outage.
  it("serves the instance default even when it is outside the allowlist", async () => {
    const runtime = await startWithAllowlist("default-exempt", ["claude-sonnet-4-6"], {
      default: "anthropic:claude-opus-4-6",
      fast: "anthropic:claude-opus-4-6",
      reasoning: "anthropic:claude-opus-4-6",
    });
    try {
      expect(await chatError(runtime)).not.toBeInstanceOf(ModelNotAllowedError);
    } finally {
      await runtime.shutdown();
    }
  });

  it("serves a slot name even when the slot's model is outside the allowlist", async () => {
    const runtime = await startWithAllowlist("slot-exempt", ["claude-sonnet-4-6"], {
      default: "anthropic:claude-opus-4-6",
      fast: "anthropic:claude-opus-4-6",
      reasoning: "anthropic:claude-opus-4-6",
    });
    try {
      expect(await chatError(runtime, "alias:fast")).not.toBeInstanceOf(ModelNotAllowedError);
      expect(await chatError(runtime, "fast")).not.toBeInstanceOf(ModelNotAllowedError);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("a deployment with no providers config has no policy to enforce", () => {
  // The regression this pair guards. `getProviderConfigs()` falls back to
  // `{anthropic:{}}` when `providers` is unset — a display default, not a
  // reachability claim. Consulting it on the legacy config, or behind a custom
  // adapter that serves every string, refuses every non-Anthropic model on a
  // deployment that can serve them. An allowlist nobody configured denies
  // nothing.
  async function startWithoutProviders(name: string) {
    const workDir = join(testDir, name);
    mkdirSync(workDir, { recursive: true });
    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);
    return runtime;
  }

  it("serves a model from a provider the display default does not name", async () => {
    const runtime = await startWithoutProviders("no-policy-google");
    try {
      expect(await chatError(runtime, "google:gemini-3.1-pro-preview")).not.toBeInstanceOf(
        ModelNotAllowedError,
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("serves a bespoke id no catalog claims", async () => {
    const runtime = await startWithoutProviders("no-policy-bespoke");
    try {
      expect(await chatError(runtime, "some-proxy:pinned-build-42")).not.toBeInstanceOf(
        ModelNotAllowedError,
      );
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("the gate runs where the model is used, not on every turn", () => {
  // A resume reads `conversation.model` and discards whatever the request
  // carried, so refusing the request over that value refuses a turn on a model
  // it never runs. Building the create options eagerly did exactly that.
  //
  // The conversation is seeded through the store rather than a first turn: the
  // allowlist rides on `providers`, which displaces the echo adapter, so no
  // turn can complete in this harness. Only the resume path is under test.
  it("resumes a conversation pinned to an allowed model despite an off-list request model", async () => {
    const runtime = await startWithAllowlist("resume-unaffected", ["claude-sonnet-4-6"]);
    try {
      const store = runtime.workspaceConversationStore(TEST_WORKSPACE_ID, "_dev");
      const { id } = await store.create({
        ownerId: "_dev",
        workspaceId: TEST_WORKSPACE_ID,
        model: "anthropic:claude-sonnet-4-6",
      });

      const err = await runtime
        .chat({
          message: "again",
          workspaceId: TEST_WORKSPACE_ID,
          conversationId: id,
          model: "anthropic:claude-opus-4-6",
        })
        .then(
          () => null,
          (e) => e,
        );
      expect(err).not.toBeInstanceOf(ModelNotAllowedError);
    } finally {
      await runtime.shutdown();
    }
  });
});
