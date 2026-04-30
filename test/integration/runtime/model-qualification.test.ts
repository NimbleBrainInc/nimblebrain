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
        reasoning: "gemini-3.1-pro-preview",
      },
    });
    try {
      const slots = runtime.getModelSlots();
      expect(slots.default).toBe("anthropic:claude-sonnet-4-6");
      expect(slots.fast).toBe("openai:gpt-4o");
      expect(slots.reasoning).toBe("google:gemini-3.1-pro-preview");
    } finally {
      await runtime.shutdown();
    }
  });
});
