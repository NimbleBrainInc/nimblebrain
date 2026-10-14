/**
 * Platform app schema audit.
 *
 * The in-process gate validates every platform tool call against its declared
 * inputSchema, and refuses every call to a tool whose schema does not compile:
 * one malformed schema makes that tool unusable.
 *
 * This audit catches that at test time: it iterates every platform app
 * factory, constructs the source, pulls its advertised tools, and compiles
 * each schema under its declared dialect. It must not throw.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { createConversationsSource } from "../../../src/platform/conversations/source.ts";
import { createFilesSource } from "../../../src/platform/files/source.ts";
import { createUsageSource } from "../../../src/platform/usage/source.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";
import type { McpSource } from "../../../src/tools/mcp-source.ts";
import { compileJsonSchema } from "../../../src/util/json-schema-dialect.ts";
import { stub } from "../../helpers/stub.ts";

/**
 * Minimal runtime stub sufficient for every synchronous / lazy platform
 * factory.
 *
 * Coverage gap: tasks is excluded. Its factory starts a `Scheduler`
 * at construction that the resulting `InlineSource` doesn't expose a stop
 * hook for, so including it here leaks timers across tests. Its schemas
 * are exercised indirectly by the real tests in test/unit/platform/
 * tasks/. Tracked by #30 — closing this gap cleanly means giving
 * `InlineSource` an optional onStop callback factories can wire through.
 */
function makeRuntime(workDir: string): Runtime {
  return stub<Runtime>({
    getWorkDir: () => workDir,
    getWorkspaceScopedDir: () => workDir,
    getCurrentWorkspaceId: () => "ws_001b7d589bde72e7",
    getCurrentIdentity: () => null,
    getDefaultModel: () => "claude-sonnet-4-6",
    getWorkspaceStore: () => null,
    chat: async () => {
      throw new Error("the schema audit lists tools and runs no chat");
    },
  });
}

async function auditSource(source: McpSource): Promise<void> {
  await source.start();
  try {
    const tools = await source.tools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(() => compileJsonSchema(tool.inputSchema)).not.toThrow();
    }
  } finally {
    await source.stop();
  }
}

describe("Connector audit — every inline connector has compilable schemas", () => {
  test("files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-files-"));
    try {
      await auditSource(createFilesSource(makeRuntime(dir), new NoopEventSink()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-usage-"));
    try {
      await auditSource(createUsageSource(makeRuntime(dir), new NoopEventSink()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("conversations", async () => {
    // The conversations source lazily constructs its fs-watch index on first
    // tool call, so simple construction is side-effect-free.
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-conv-"));
    try {
      await auditSource(await createConversationsSource(makeRuntime(dir), new NoopEventSink()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
