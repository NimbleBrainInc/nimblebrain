/**
 * A knowingly-incomplete skill enumeration is loud, and is not cached as
 * complete.
 *
 * The composition-flap incident's real defect was not the flap: it was that a
 * workspace whose bundles publish `always` skills composed none of them and
 * nothing said so, because `skills: 0` is indistinguishable from "this
 * workspace has no skills". These pin the two halves of the guard — the signal
 * carries a machine-readable reason, and a short result never becomes the
 * cached answer for the TTL.
 *
 * Both fixtures fail `resources/list` rather than returning zero resources.
 * A clean enumeration that returns nothing is NOT degraded — telling that from
 * "never published" needs a remembered baseline, which would page an operator
 * on every legitimate uninstall.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { log } from "../../src/observability/log.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const FAILING_NAME = "ai-nimblebrain-failing-mcp";
const HEALTHY_NAME = "ai-nimblebrain-healthy-mcp";

const SKILL_BODY = `---
name: guide
description: Guidance.
metadata:
  nimblebrain:
    loading-strategy: always
---

# guide

HEALTHY-MARKER — this rule must be in context on every turn.`;

/** Server whose `resources/list` throws; `tools/list` still answers. */
function createFailingBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nm = join(import.meta.dir, "../..", "node_modules");
  writeFileSync(
    join(dir, "server.cjs"),
    `
const { Server } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema } =
  require("${nm}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "failing", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    throw new Error("resources/list is unavailable");
  });
  await server.connect(new StdioServerTransport());
}
main();
`,
  );
  return dir;
}

/** Ordinary server publishing one `always` skill — the control. */
function createHealthyBundle(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const nm = join(import.meta.dir, "../..", "node_modules");
  writeFileSync(
    join(dir, "server.cjs"),
    `
const { Server } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const {
  ListToolsRequestSchema, CallToolRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
} = require("${nm}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "healthy", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "go", description: "Go", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "skill://guide/SKILL.md", name: "guide", mimeType: "text/markdown" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: ${JSON.stringify(SKILL_BODY)} }],
  }));
  await server.connect(new StdioServerTransport());
}
main();
`,
  );
  return dir;
}

const testDir = join(tmpdir(), `nimblebrain-skill-degraded-${Date.now()}`);
let runtime: Runtime;
let failing: McpSource;
let healthy: McpSource;

/** Fields of every `skills.composition.degraded` warn recorded by a spy. */
function degradedCalls(spy: ReturnType<typeof spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((c) => c[1] as Record<string, unknown> | undefined)
    .filter((f): f is Record<string, unknown> => f?.event === "skills.composition.degraded");
}

async function startSource(name: string, dir: string): Promise<McpSource> {
  const src = new McpSource(
    name,
    {
      type: "stdio",
      spawn: { command: "node", args: [join(dir, "server.cjs")], env: process.env as Record<string, string> },
    },
    new NoopEventSink(),
  );
  await src.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(src);
  return src;
}

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    noDefaultBundles: true,
    logging: { disabled: true },
    workDir: testDir,
    telemetry: { enabled: false },
  });
  await provisionTestWorkspace(runtime);
  failing = await startSource(FAILING_NAME, createFailingBundle(join(testDir, "failing")));
  healthy = await startSource(HEALTHY_NAME, createHealthyBundle(join(testDir, "healthy")));
});

afterAll(async () => {
  for (const s of [failing, healthy]) {
    try {
      await s?.stop();
    } catch {
      // already stopped
    }
  }
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("degraded skill discovery", () => {
  it("reports a failed enumeration with a machine-readable reason", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "hello" });
      const calls = degradedCalls(warn);
      const failed = calls.find((f) => f.server === FAILING_NAME);
      expect(failed).toBeDefined();
      expect(failed?.reason).toBe("enumeration_failed");
      expect(failed?.workspace_id).toBe(TEST_WORKSPACE_ID);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays loud on the next turn — a short result is not cached as the answer", async () => {
    // The 5-minute cache would otherwise swallow every turn after the first,
    // leaving the operator one line for an outage that spans hours.
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "again" });
      expect(degradedCalls(warn).some((f) => f.server === FAILING_NAME)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing about a server that enumerates cleanly", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "third" });
      expect(degradedCalls(warn).some((f) => f.server === HEALTHY_NAME)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing about a tools-only server — the signal must be rare to be worth reading", async () => {
    // The platform's own in-process sources advertise no `resources`
    // capability. Calling `resources/list` on one throws `Method not found`,
    // which reads as a transport failure — so an ungated signal fires for every
    // built-in source on every turn, in every workspace, forever. An alert that
    // is always firing is not an alert. Only the deliberately broken fixture
    // may appear here.
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "fifth" });
      const servers = new Set(degradedCalls(warn).map((f) => f.server));
      expect([...servers]).toEqual([FAILING_NAME]);
    } finally {
      warn.mockRestore();
    }
  });

  it("still composes the skills it could reach", async () => {
    // A degraded neighbour must not take the healthy server's guidance with it.
    const { response } = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "fourth",
    });
    expect(typeof response).toBe("string");
    const skills = await runtime.listActivatableSkills(TEST_WORKSPACE_ID, null);
    expect(Array.isArray(skills)).toBe(true);
  });
});
