/**
 * Bundle schema audit.
 *
 * Since InlineSource now validates every tool call against its declared
 * inputSchema, a malformed schema in any bundle would cause AJV compilation
 * to throw at runtime on the first call — turning a silent bug in one
 * bundle into a visible failure.
 *
 * This audit catches that at test time: it iterates every platform bundle
 * factory, constructs the source, pulls its advertised tools, and forces
 * schema compilation by running validateToolInput against an empty input.
 * We don't care whether validation passes — we care that compilation
 * succeeds (no throw).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFilesSource } from "../../../src/tools/platform/files.ts";
import { createHomeSource } from "../../../src/tools/platform/home.ts";
import { createSettingsSource } from "../../../src/tools/platform/settings.ts";
import { createUsageSource } from "../../../src/tools/platform/usage.ts";
import { createConversationsSource } from "../../../src/tools/platform/conversations.ts";
import type { InlineSource } from "../../../src/tools/inline-source.ts";
import { validateToolInput } from "../../../src/tools/validate-input.ts";
import type { Runtime } from "../../../src/runtime/runtime.ts";

/**
 * Minimal runtime stub sufficient for every synchronous / lazy platform
 * factory. Automations is excluded from this audit because its factory
 * starts a scheduler at construction with no externally-accessible stop
 * hook; its schemas are already exercised by tests in test/unit/bundles/
 * automations/.
 */
function makeRuntime(workDir: string): Runtime {
  return {
    getWorkDir: () => workDir,
    getWorkspaceScopedDir: () => workDir,
    getCurrentWorkspaceId: () => "ws_audit",
    getCurrentIdentity: () => null,
    getDefaultModel: () => "claude-sonnet-4-6",
    getWorkspaceStore: () => null,
    chat: async () => ({ content: [], usage: { inputTokens: 0, outputTokens: 0 } }),
  } as unknown as Runtime;
}

async function auditSource(source: InlineSource): Promise<void> {
  const tools = await source.tools();
  expect(tools.length).toBeGreaterThan(0);
  for (const tool of tools) {
    // If AJV can't compile the schema, this throws synchronously.
    // The return value (valid/invalid against {}) is irrelevant here.
    expect(() => validateToolInput({}, tool.inputSchema)).not.toThrow();
  }
}

describe("Bundle audit — every inline bundle has compilable schemas", () => {
  test("files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-files-"));
    try {
      await auditSource(createFilesSource(makeRuntime(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-home-"));
    try {
      await auditSource(createHomeSource(makeRuntime(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-settings-"));
    try {
      await auditSource(createSettingsSource(makeRuntime(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-usage-"));
    try {
      await auditSource(createUsageSource(makeRuntime(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("conversations", async () => {
    // The conversations source lazily constructs its fs-watch index on first
    // tool call, so simple construction is side-effect-free.
    const dir = mkdtempSync(join(tmpdir(), "nb-audit-conv-"));
    try {
      await auditSource(await createConversationsSource(makeRuntime(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
