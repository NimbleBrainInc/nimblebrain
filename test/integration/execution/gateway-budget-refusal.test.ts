import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "../../../src/engine/types.ts";
import { DEV_IDENTITY } from "../../../src/identity/providers/dev.ts";
import { Runtime } from "../../../src/runtime/runtime.ts";
import { devProvider } from "../../helpers/dev-provider.ts";
import { type FakeAnthropic, startFakeAnthropic } from "../../helpers/fake-anthropic.ts";
import { runKeyJwk, runKeyRingValue } from "../../helpers/run-key.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../../helpers/test-workspace.ts";

// The native engine with every provider reached through a model gateway that
// refuses the run's calls because the run's budget is spent: the provider's
// real client (the AI SDK's Anthropic client) reads the gateway's answer.

const MODEL = "anthropic:claude-sonnet-4-6";
const RUN_KEY_ENV = "NB_TEST_GATEWAY_REFUSAL_RUN_KEY";

describe("the native engine, refused by the gateway for a spent run budget", () => {
  const workDir = join(tmpdir(), `nb-gateway-refusal-${Date.now()}`);
  let gateway: FakeAnthropic;
  let runtime: Runtime;
  const events: EngineEvent[] = [];

  beforeAll(async () => {
    gateway = startFakeAnthropic({ toolInput: "{}", refuseAfter: 0 });
    mkdirSync(workDir, { recursive: true });
    process.env[RUN_KEY_ENV] = runKeyRingValue(runKeyJwk("run-1"));
    runtime = await Runtime.start({
      identityProvider: devProvider,
      models: { default: MODEL },
      logging: { disabled: true },
      workDir,
      secrets: { runKeyEnv: RUN_KEY_ENV },
      execution: { modelGateway: gateway.rootUrl },
      events: [{ emit: (e) => events.push(e) }],
    });
    await provisionTestWorkspace(runtime);
  });

  afterAll(async () => {
    await runtime?.shutdown();
    await gateway?.close();
    delete process.env[RUN_KEY_ENV];
    rmSync(workDir, { recursive: true, force: true });
  });

  test("ends the turn at once with spend_limit, sending the refused call once", async () => {
    const before = gateway.requests.length;
    const seen = events.length;
    const result = await runtime.chat({
      message: "hello",
      workspaceId: TEST_WORKSPACE_ID,
      identity: DEV_IDENTITY,
    });

    expect(result.stopReason).toBe("spend_limit");
    // The turn's one call, refused and not retried. (A title, if one is
    // written, is its own call without the turn's tools.)
    const turnCalls = gateway.requests.slice(before).filter((r) => (r.tools?.length ?? 0) > 0);
    expect(turnCalls).toHaveLength(1);
    const types = events.slice(seen).map((e) => e.type);
    expect(types).toContain("run.done");
    expect(types).not.toContain("run.error");
    expect(types).not.toContain("llm.error");
  });
});
