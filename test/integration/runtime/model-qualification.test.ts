import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent, EventSink } from "../../../src/engine/types.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { createEchoModel } from "../../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../../helpers/test-workspace.ts";

const testDir = join(tmpdir(), `nimblebrain-model-qualification-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("model qualification at runtime boundary", () => {
  it("qualifies a bare gemini id before propagating to engine config", async () => {
    // Regression guard: a tenant whose disk has a legacy bare model id
    // (`gemini-3.1-pro-preview`, written by an older settings UI) needs
    // the qualified form to reach every downstream consumer — cost
    // aggregation, capability checks, max-output and thinking resolvers,
    // provider-options shape, log lines. Without qualification at the
    // request-entry boundary, the resolver-side rescue inside
    // `buildModelResolver` only fixes routing; everything else still
    // sees the bare string and misbehaves (e.g., usage-aggregator
    // looking up the bare id under anthropic, finding nothing, and
    // reporting $0 cost).
    const workDir = join(testDir, "qualify-bare-gemini");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    await runtime.chat(
      {
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        // Bare id, as it would be on disk for a legacy tenant.
        model: "gemini-3.1-pro-preview",
      },
      sink,
    );

    // run.start.data.model is sourced from `engineConfig.model` after
    // the runtime's resolution step. If qualification is in place, this
    // is "google:gemini-3.1-pro-preview"; if not, it leaks the bare id
    // to every downstream consumer.
    const runStart = events.find((e) => e.type === "run.start");
    expect(runStart).toBeDefined();
    expect(runStart!.data.model).toBe("google:gemini-3.1-pro-preview");

    await runtime.shutdown();
  });

  it("leaves an already-qualified id unchanged", async () => {
    const workDir = join(testDir, "qualify-already-qualified");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
    });
    await provisionTestWorkspace(runtime);

    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    await runtime.chat(
      {
        message: "hello",
        workspaceId: TEST_WORKSPACE_ID,
        model: "google:gemini-3.1-pro-preview",
      },
      sink,
    );

    const runStart = events.find((e) => e.type === "run.start");
    expect(runStart).toBeDefined();
    expect(runStart!.data.model).toBe("google:gemini-3.1-pro-preview");

    await runtime.shutdown();
  });

  it("getModelSlots() returns qualified ids when stored config has bare strings", async () => {
    // Ensures the slot reader qualifies — get_config (which feeds the
    // settings UI dropdown), telemetry, and any other consumer that
    // reads slots directly all see fully-qualified `provider:id`.
    const workDir = join(testDir, "qualify-slot-reader");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
      // Stored config simulates the legacy state: bare ids saved by an
      // older settings UI that didn't encode the provider into option
      // values.
      models: {
        default: "claude-sonnet-4-6",
        fast: "gpt-4o",
      },
    });
    try {
      const slots = runtime.getModelSlots();
      expect(slots.default).toBe("anthropic:claude-sonnet-4-6");
      expect(slots.fast).toBe("openai:gpt-4o");
    } finally {
      await runtime.shutdown();
    }
  });

  it("resolves a bare slot name on the request door and qualifies the slot's value", async () => {
    // The two spellings of a slot reference must land on the same model,
    // and the slot's stored value must arrive qualified. Without slot
    // parsing, "fast" is not a catalog id, so `resolveModelString` stamps
    // it `anthropic:fast` — a model that does not exist.
    const workDir = join(testDir, "slot-ref-request-door");
    mkdirSync(workDir, { recursive: true });

    const runtime = await Runtime.start({
      model: { provider: "custom", adapter: createEchoModel() },
      noDefaultBundles: true,
      workDir,
      models: {
        default: "anthropic:claude-sonnet-4-6",
        fast: "gpt-4o", // bare on purpose — the slot read must qualify it
      },
    });
    await provisionTestWorkspace(runtime);

    try {
      for (const spelling of ["fast", "alias:fast"]) {
        const events: EngineEvent[] = [];
        const sink: EventSink = { emit: (e) => events.push(e) };

        await runtime.chat(
          { message: "hello", workspaceId: TEST_WORKSPACE_ID, model: spelling },
          sink,
        );

        const runStart = events.find((e) => e.type === "run.start");
        expect(runStart).toBeDefined();
        expect(runStart!.data.model).toBe("openai:gpt-4o");
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("resolves a bare slot name in an agent profile through the delegate door", async () => {
    // `resolveSlot` is a distinct reader from the request door's, reached
    // only through `nb__delegate`. It routes to `getModelSlot` so the two
    // cannot disagree — this pins the child engine's model, which feeds
    // `resolveMaxOutputTokens` and `resolveThinking` (both catalog lookups
    // that treat a bare id as Anthropic's and silently miss).
    const workDir = join(testDir, "slot-ref-delegate-door");
    mkdirSync(workDir, { recursive: true });

    // The child engine emits onto the RUNTIME-level sink (delegate builds its
    // ChildEventSink from `delegateCtx.events`), not the per-chat sink.
    const events: EngineEvent[] = [];
    const sink: EventSink = { emit: (e) => events.push(e) };

    const runtime = await Runtime.start({
      events: [sink],
      model: {
        provider: "custom",
        adapter: createEchoModel({
          responses: [
            {
              text: "delegating",
              toolCalls: [
                {
                  toolCallId: "call_1",
                  toolName: "nb__delegate",
                  input: JSON.stringify({ task: "summarize", agent: "analyst" }),
                },
              ],
            },
          ],
        }),
      },
      noDefaultBundles: true,
      workDir,
      models: {
        default: "anthropic:claude-sonnet-4-6",
        fast: "gemini-3.1-pro-preview", // bare on purpose
      },
      agents: {
        analyst: {
          description: "Analyst",
          systemPrompt: "You analyze.",
          tools: [],
          // The bare spelling `workspace.json` documents.
          model: "fast",
        },
      },
    });
    await provisionTestWorkspace(runtime);

    try {
      await runtime.chat({ message: "hello", workspaceId: TEST_WORKSPACE_ID }, { emit: () => {} });

      // The child engine's events carry parentRunId (see ChildEventSink).
      const childStart = events.find((e) => e.type === "run.start" && e.data.parentRunId);
      expect(childStart).toBeDefined();
      expect(childStart!.data.model).toBe("google:gemini-3.1-pro-preview");
    } finally {
      await runtime.shutdown();
    }
  });
});
