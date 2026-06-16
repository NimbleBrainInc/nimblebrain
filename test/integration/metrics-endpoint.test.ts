/**
 * Proves the domain metrics are safe with NO Prometheus configured.
 *
 * There is nothing to configure: `prom-client` is an in-process registry, the
 * `MetricsEventSink` only increments in-memory counters, and `/metrics` is
 * mounted unconditionally. This test boots the full Runtime + HTTP server with
 * zero metrics infra (no Prometheus, no k8s, no scraper, no env), runs a real
 * chat turn through the metrics sink, and confirms nothing breaks and the
 * counters populate — exactly the local `bun run dev` case.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/api/server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { createTestAuthAdapter } from "../helpers/test-auth-adapter.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const API_KEY = "metrics-endpoint-test-key-1234";
let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const workDir = join(tmpdir(), `nimblebrain-metrics-${Date.now()}`);

beforeAll(async () => {
  mkdirSync(workDir, { recursive: true });
  // No metrics config of any kind — this is the bare local/no-k8s setup.
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir,
  });
  await provisionTestWorkspace(runtime);
  handle = startServer({
    runtime,
    port: 0,
    provider: createTestAuthAdapter(API_KEY, runtime),
  });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle?.stop(true);
  await runtime?.shutdown();
  rmSync(workDir, { recursive: true, force: true });
});

describe("metrics with no Prometheus configured", () => {
  test("server boots and /metrics serves with zero metrics infra", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Domain counters are registered at module load, so they're exposed even
    // before any increment — no scraper or config required.
    expect(body).toContain("nb_llm_tokens_total");
    expect(body).toContain("nb_tool_promotions_total");
  });

  test("a chat turn drives the metrics sink without error and populates a counter", async () => {
    const chat = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "X-Workspace-Id": TEST_WORKSPACE_ID,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    // The turn runs through MetricsEventSink (always wired) — must not throw.
    expect(chat.status).toBe(200);

    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    // The echo turn emitted llm.done → recordLlmUsage("main"), so the main-loop
    // call counter is present and positive.
    expect(body).toMatch(/nb_llm_calls_total\{[^}]*source="main"[^}]*\}\s+[1-9]/);
  });
});
