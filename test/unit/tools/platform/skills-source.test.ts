/**
 * Platform `skills` source contract tests.
 *
 * Verifies the source-level contract: factory returns a started McpSource;
 * tools/list surfaces exactly the four read tools; resources/list publishes
 * the Layer 1 vendored guide URI; tool descriptions are production-quality.
 *
 * Detailed handler behavior (filtering, dispatch, permissions) lives in
 * `skills-tools.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createSkillsSource } from "../../../../src/tools/platform/skills.ts";

// ── Fake Runtime ────────────────────────────────────────────────────────
//
// The scaffold-level contract tests never call any handler in earnest, so
// the runtime stub provides only the methods the handler skeleton invokes
// during dispatch (e.g. `getWorkDir` is read by `read` to compute allowed
// roots even on validation-rejection paths). Tests that exercise real
// handler logic live in `skills-tools.test.ts`.

class FakeRuntime {
  constructor(private workDir: string) {}
  getWorkDir(): string {
    return this.workDir;
  }
  getCurrentIdentity(): null {
    return null;
  }
  requireWorkspaceId(): never {
    throw new Error("no workspace");
  }
  getConversationStore(): never {
    throw new Error("no store");
  }
  getContextSkills(): never[] {
    return [];
  }
  getMatchableSkills(): never[] {
    return [];
  }
  loadConversationSkills(): never[] {
    return [];
  }
}

let workDir: string;
let source: McpSource | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "skills-src-contract-"));
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

async function buildSource(): Promise<McpSource> {
  const runtime = new FakeRuntime(workDir);
  source = createSkillsSource(runtime as unknown as never, new NoopEventSink());
  await source.start();
  return source;
}

// ── Source factory ──────────────────────────────────────────────────────

describe("skills source — factory", () => {
  test("returns a started McpSource", async () => {
    const src = await buildSource();
    expect(src).toBeInstanceOf(McpSource);
    expect(src.getClient()).not.toBeNull();
  });
});

// ── Tools list ──────────────────────────────────────────────────────────

describe("skills source — tools list", () => {
  test("exposes exactly the four Phase 2 read tools", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["active_for", "list", "loading_log", "read"]);
  });

  test("does NOT expose Phase 3 mutation tools yet", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain("create");
    expect(names).not.toContain("update");
    expect(names).not.toContain("delete");
    expect(names).not.toContain("activate");
    expect(names).not.toContain("deactivate");
    expect(names).not.toContain("move_scope");
    expect(names).not.toContain("author");
    expect(names).not.toContain("commit_draft");
    expect(names).not.toContain("lint");
    expect(names).not.toContain("attribution");
  });

  test("each tool has a non-trivial production-quality description", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const tools = await client.listTools();
    for (const t of tools.tools) {
      expect(t.description).toBeTruthy();
      expect((t.description ?? "").length).toBeGreaterThan(50);
    }
  });
});

// ── Schema rejection ────────────────────────────────────────────────────

describe("skills source — schema rejection", () => {
  test("read without id is rejected by schema validation", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "read", arguments: {} });
    expect(result.isError).toBe(true);
  });

  test("active_for without conversation_id is rejected", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "active_for", arguments: {} });
    expect(result.isError).toBe(true);
  });
});

// ── Resources ───────────────────────────────────────────────────────────

describe("skills source — resources", () => {
  test("resources/list includes skill://skills/authoring-guide", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain("skill://skills/authoring-guide");
  });

  test("resources/read returns non-empty markdown for the authoring guide", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const data = await client.readResource({ uri: "skill://skills/authoring-guide" });
    const text = (data.contents?.[0]?.text as string | undefined) ?? "";
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    // Real Task 005 content begins with frontmatter (`---`); the placeholder
    // starts with `# Authoring Guide`. Accept either shape.
    expect(text.startsWith("#") || text.startsWith("---")).toBe(true);
  });

  test("authoring guide is served as text/markdown", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const data = await client.readResource({ uri: "skill://skills/authoring-guide" });
    expect(data.contents?.[0]?.mimeType).toBe("text/markdown");
  });
});
