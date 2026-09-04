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
 * The degraded fixtures each break a different leg — a throwing
 * `resources/list`, an endless cursor, a listed skill that cannot be read —
 * rather than returning zero resources. A clean enumeration that returns
 * nothing is NOT degraded — telling that from "never published" needs a
 * remembered baseline, which would page an operator on every legitimate
 * uninstall.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import type { BundleRef } from "../../src/bundles/types.ts";
import { log } from "../../src/observability/log.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { TEST_WORKSPACE_ID, provisionTestWorkspace } from "../helpers/test-workspace.ts";

const FAILING_NAME = "ai-nimblebrain-failing-mcp";
const HEALTHY_NAME = "ai-nimblebrain-healthy-mcp";
const TRUNCATED_NAME = "ai-nimblebrain-truncated-mcp";
const UNREADABLE_NAME = "ai-nimblebrain-unreadable-mcp";
/** Every fixture that must produce a degraded signal; nothing else may. */
const DEGRADED_FIXTURES = [FAILING_NAME, TRUNCATED_NAME, UNREADABLE_NAME];

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

/** Server whose `resources/list` always returns a cursor — never finishes. */
function createTruncatedBundle(dir: string): string {
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
    { name: "truncated", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  let page = 0;
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    page++;
    return {
      resources: [{ uri: "res://filler/" + page, name: "filler-" + page }],
      nextCursor: "page-" + page,
    };
  });
  await server.connect(new StdioServerTransport());
}
main();
`,
  );
  return dir;
}

/** Server that LISTS one skill entrypoint but throws on every read. */
function createUnreadableBundle(dir: string): string {
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
    { name: "unreadable", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "done" }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "skill://broken/SKILL.md", name: "broken", mimeType: "text/markdown" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async () => {
    throw new Error("resources/read is unavailable");
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
let truncated: McpSource;
let unreadable: McpSource;

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
  truncated = await startSource(TRUNCATED_NAME, createTruncatedBundle(join(testDir, "truncated")));
  unreadable = await startSource(UNREADABLE_NAME, createUnreadableBundle(join(testDir, "unreadable")));
});

afterAll(async () => {
  for (const s of [failing, healthy, truncated, unreadable]) {
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

  it("reports a page-cap truncation, and stays loud next turn — a capped walk is not cached as complete", async () => {
    // The truncated fixture answers every page with another cursor, so the
    // 10-page ceiling stops the walk with resources outstanding. That result
    // reads as success (`ok: true`) — without the `truncated` flag it would
    // cache as "this is everything" and any skill past the cap stays dark for
    // the TTL. The second turn proves the short set was not cached.
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "capped" });
      const first = degradedCalls(warn).find((f) => f.server === TRUNCATED_NAME);
      expect(first?.reason).toBe("enumeration_truncated");
      warn.mockClear();
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "capped again" });
      const second = degradedCalls(warn).find((f) => f.server === TRUNCATED_NAME);
      expect(second?.reason).toBe("enumeration_truncated");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a listed skill that cannot be read, and stays loud next turn", async () => {
    // `resources/list` succeeds and names one skill entrypoint; every read
    // throws. The read swallow is deliberate (one bad skill must not sink the
    // discovery), so without the entrypoint count this caches zero skills as
    // the complete answer — the same silent shortfall the PR exists to close.
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "unreadable" });
      const first = degradedCalls(warn).find((f) => f.server === UNREADABLE_NAME);
      expect(first?.reason).toBe("skill_unreadable");
      expect(first?.recovered).toBe(0);
      warn.mockClear();
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "unreadable again" });
      expect(degradedCalls(warn).some((f) => f.server === UNREADABLE_NAME)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing about any other server — the signal must be rare to be worth reading", async () => {
    // The tools-only in-process platform sources (`usage`, `compose`) advertise
    // no `resources` capability; calling `resources/list` on one throws
    // `Method not found`, which reads as a transport failure — so an ungated
    // signal fires for them on every turn, in every workspace, forever. An
    // alert that is always firing is not an alert. The healthy fixture and the
    // resource-advertising platform sources must stay silent too: only the
    // deliberately degraded fixtures may appear.
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "fifth" });
      const servers = new Set(degradedCalls(warn).map((f) => f.server as string));
      expect(servers.size).toBeGreaterThan(0);
      for (const server of servers) {
        expect(DEGRADED_FIXTURES).toContain(server);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("still composes the skills it could reach", async () => {
    // Three degraded neighbours must not take the healthy server's guidance
    // with them. Assert on the discovered pool's CONTENT: the healthy `always`
    // skill, marker and all, survives discovery next to the degraded fixtures.
    // (An empty pool or a dropped body fails this — asserting only on types
    // could not.)
    const { response } = await runtime.chat({
      workspaceId: TEST_WORKSPACE_ID,
      message: "fourth",
    });
    expect(typeof response).toBe("string");
    const pool = await (
      runtime as unknown as {
        loadBundleSkills: (wsId: string) => Promise<Array<{ body: string; manifest: unknown }>>;
      }
    ).loadBundleSkills(TEST_WORKSPACE_ID);
    const healthySkill = pool.find((s) => s.body.includes("HEALTHY-MARKER"));
    expect(healthySkill).toBeDefined();
  });

  it("reports source_unavailable only for a bundle believed running — an auth-resting connector stays silent", async () => {
    // A URL connector nobody has connected seeds `not_authenticated` with no
    // registry source BY DESIGN — the ordinary state of every never-connected
    // and every disconnected connector. Reporting it would fire on every turn
    // of every workspace with an unconnected connector, forever. Only an
    // instance the lifecycle believes is `running` while the registry lacks
    // its source is the anomaly the reason exists for.
    const GHOST_NAME = "ai-nimblebrain-ghost-mcp";
    const lifecycle = runtime.getLifecycle();
    const ref = {
      url: "http://127.0.0.1:9/mcp",
      serverName: GHOST_NAME,
      transport: { type: "streamable-http" },
      oauthScope: "workspace",
    } as unknown as BundleRef;
    await lifecycle.seedInstance(
      GHOST_NAME,
      "@nimblebraininc/ghost",
      ref,
      undefined,
      TEST_WORKSPACE_ID,
    );
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const seeded = lifecycle.getInstances().find((i) => i.serverName === GHOST_NAME);
      expect(seeded?.state).toBe("not_authenticated");

      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "ghost quiet" });
      expect(degradedCalls(warn).some((f) => f.server === GHOST_NAME)).toBe(false);

      if (seeded) seeded.state = "running";
      warn.mockClear();
      await runtime.chat({ workspaceId: TEST_WORKSPACE_ID, message: "ghost loud" });
      const ghost = degradedCalls(warn).find((f) => f.server === GHOST_NAME);
      expect(ghost?.reason).toBe("source_unavailable");
      expect(ghost?.recovered).toBe(0);
    } finally {
      warn.mockRestore();
      lifecycle.removeInstance(GHOST_NAME, TEST_WORKSPACE_ID);
    }
  });
});
