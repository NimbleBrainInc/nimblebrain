/**
 * Parity check — TypeBox schemas in `schemas/skills.ts` produce JSON Schema
 * byte-equivalent to the inline `inputSchema` literals declared inside
 * `src/tools/platform/skills.ts`. The schemas are not yet wired into the
 * source (PR 2 swaps them in); this test guards against drift between the
 * two declarations during the migration window so PR 2's swap is a no-op
 * for AJV.
 *
 * When PR 2 lands and the inline literals go away, delete this file —
 * the catalog schemas become the source of truth and there's nothing left
 * to compare against.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import type { McpSource } from "../../../../src/tools/mcp-source.ts";
import { PlatformToolCatalog } from "../../../../src/tools/platform/schemas/catalog.ts";
import { createSkillsSource } from "../../../../src/tools/platform/skills.ts";

function makeRuntimeStub(workDir: string): unknown {
  return {
    getWorkDir: () => workDir,
    getCurrentIdentity: () => null,
    getIdentityProvider: () => null,
    requireWorkspaceId: () => "_dev",
    getCurrentWorkspaceId: () => "_dev",
    getConversationStore: () => ({}),
    getInstructionsStore: () => ({
      read: async () => "",
      write: async () => ({ updated_at: new Date().toISOString() }),
    }),
    getWorkspaceStore: () => ({ get: async () => null }),
    getWorkspaceScopedDir: () => workDir,
    getRequestContext: () => null,
    getDefaultModel: () => "echo:test",
    getContextSkills: () => [],
    getMatchableSkills: () => [],
    loadConversationSkills: () => [],
    registerAutomationsContext: () => {},
  };
}

/** JSON-roundtrip strips TypeBox's Symbol-keyed metadata so deep-equal works. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("skills schemas — TypeBox parity with inline declarations", () => {
  let workDir: string;
  let source: McpSource;
  let inlineByTool: Map<string, Record<string, unknown>>;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "skills-parity-"));
    const runtime = makeRuntimeStub(workDir) as Parameters<typeof createSkillsSource>[0];
    source = createSkillsSource(runtime, new NoopEventSink());
    await source.start();
    const client = source.getClient();
    if (!client) throw new Error("skills source has no client");
    const { tools } = await client.listTools();
    inlineByTool = new Map(
      tools.map((t) => [t.name, (t.inputSchema as Record<string, unknown>) ?? {}]),
    );
  });

  afterEach(async () => {
    await source.stop?.();
    rmSync(workDir, { recursive: true, force: true });
  });

  // Each catalog entry should match the inline schema for that tool name.
  for (const toolName of Object.keys(PlatformToolCatalog.skills)) {
    test(`skills__${toolName} catalog schema equals inline schema`, () => {
      const inline = plain(inlineByTool.get(toolName));
      const catalog = plain(
        PlatformToolCatalog.skills[toolName as keyof typeof PlatformToolCatalog.skills].input,
      );
      expect(catalog).toEqual(inline);
    });
  }

  test("every inline skills tool has a catalog entry", () => {
    const inlineNames = [...inlineByTool.keys()].sort();
    const catalogNames = Object.keys(PlatformToolCatalog.skills).sort();
    expect(catalogNames).toEqual(inlineNames);
  });
});
