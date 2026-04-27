/**
 * Phase 2 — read-tool behavior tests for `nb__skills`.
 *
 * Exercises real handler logic against a stand-in Runtime:
 *   - `skills__list` filters (scope, layer, type, status, modified_since,
 *     tool_affinity) compose correctly and return the expected shape.
 *   - `skills__read` dispatches by id (filesystem path or `skill://` URI),
 *     rejects path-traversal attempts, and returns full content + metadata.
 *   - `skills__active_for` reads the most-recent `skills.loaded` event.
 *   - `skills__loading_log` filters by `since`/`until`/`skill_id`.
 *
 * The Runtime fixture wraps a real `EventSourcedConversationStore` rooted
 * in a tmpdir so the conversation-event paths are exercised end-to-end.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { EventSourcedConversationStore } from "../../../../src/conversation/event-sourced-store.ts";
import { parseSkillFile } from "../../../../src/skills/loader.ts";
import type { Skill } from "../../../../src/skills/types.ts";
import { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createSkillsSource } from "../../../../src/tools/platform/skills.ts";

// ── Fake Runtime ─────────────────────────────────────────────────────────

interface FakeIdentity {
  id: string;
}

class FakeRuntime {
  identity: FakeIdentity | null = null;
  wsId: string | null = null;
  private readonly _store: EventSourcedConversationStore;

  contextSkills: Skill[] = [];
  matchableSkills: Skill[] = [];
  conversationOverlay: Skill[] = [];

  constructor(private workDir: string) {
    const convDir = join(workDir, "conversations");
    mkdirSync(convDir, { recursive: true });
    this._store = new EventSourcedConversationStore({ dir: convDir });
  }

  getWorkDir(): string {
    return this.workDir;
  }
  getCurrentIdentity(): FakeIdentity | null {
    return this.identity;
  }
  requireWorkspaceId(): string {
    if (!this.wsId) throw new Error("no workspace");
    return this.wsId;
  }
  getConversationStore(): EventSourcedConversationStore {
    return this._store;
  }
  getStore(): EventSourcedConversationStore {
    return this._store;
  }
  getContextSkills(): Skill[] {
    return this.contextSkills;
  }
  getMatchableSkills(): Skill[] {
    return this.matchableSkills;
  }
  loadConversationSkills(): Skill[] {
    return this.conversationOverlay;
  }

  store(): EventSourcedConversationStore {
    return this._store;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function writeSkill(path: string, frontmatter: Record<string, unknown>, body: string): Skill {
  // Author with a tiny YAML serializer (one-pass) so tests stay hermetic.
  const yaml = serializeYaml(frontmatter);
  writeFileSync(path, `---\n${yaml}---\n\n${body}\n`);
  const parsed = parseSkillFile(path);
  if (!parsed) throw new Error(`Failed to parse fixture skill at ${path}`);
  return parsed;
}

function serializeYaml(o: Record<string, unknown>): string {
  let out = "";
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) {
      out += `${k}:\n`;
      for (const item of v) out += `  - "${item}"\n`;
    } else if (typeof v === "object" && v !== null) {
      out += `${k}:\n`;
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2)) {
          out += `  ${k2}:\n`;
          for (const item of v2) out += `    - "${item}"\n`;
        } else {
          out += `  ${k2}: ${JSON.stringify(v2)}\n`;
        }
      }
    } else {
      out += `${k}: ${JSON.stringify(v)}\n`;
    }
  }
  return out;
}

// ── Setup ────────────────────────────────────────────────────────────────

let workDir: string;
let runtime: FakeRuntime;
let source: McpSource | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "skills-tools-test-"));
  runtime = new FakeRuntime(workDir);
});

afterEach(async () => {
  if (source) await source.stop();
  source = undefined;
  rmSync(workDir, { recursive: true, force: true });
});

async function buildSource(): Promise<McpSource> {
  source = createSkillsSource(runtime as unknown as never, new NoopEventSink());
  await source.start();
  return source;
}

// ── skills__list ─────────────────────────────────────────────────────────

describe("skills__list", () => {
  test("returns Layer 1 vendored guide + Layer 3 overlay skills", async () => {
    // Stage one workspace skill via the conversation overlay.
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const skill = writeSkill(
      join(wsDir, "voice.md"),
      {
        name: "voice",
        description: "Voice rules",
        version: "1.0.0",
        type: "context",
        priority: 25,
        "loading-strategy": "always",
      },
      "Speak plainly.",
    );
    skill.manifest.scope = "workspace";
    runtime.conversationOverlay = [skill];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "list", arguments: {} });
    expect(result.isError).toBeFalsy();
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ name: string; layer: 1 | 3; scope: string }>;

    const names = skills.map((s) => s.name).sort();
    expect(names).toContain("voice");
    expect(names).toContain("authoring-guide");
    const guide = skills.find((s) => s.name === "authoring-guide")!;
    expect(guide.layer).toBe(1);
    expect(guide.scope).toBe("bundle");
    const ws = skills.find((s) => s.name === "voice")!;
    expect(ws.layer).toBe(3);
    expect(ws.scope).toBe("workspace");
  });

  test("layer filter narrows to Layer 1 only", async () => {
    runtime.conversationOverlay = [];
    runtime.wsId = "ws_a";
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "list", arguments: { layer: 1 } });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ layer: number; name: string }>;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((s) => s.layer === 1)).toBe(true);
  });

  test("scope filter narrows to a single tier", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const ws = writeSkill(
      join(wsDir, "ws-only.md"),
      { name: "ws-only", description: "x", version: "1.0.0", type: "skill", priority: 50 },
      "ws body",
    );
    ws.manifest.scope = "workspace";
    runtime.conversationOverlay = [ws];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "list",
      arguments: { scope: "workspace" },
    });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ name: string; scope: string }>;
    expect(skills.every((s) => s.scope === "workspace")).toBe(true);
    expect(skills.map((s) => s.name)).toContain("ws-only");
  });

  test("tool_affinity filter only returns skills whose applies_to_tools matches", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const collateral = writeSkill(
      join(wsDir, "collateral.md"),
      {
        name: "collateral-skill",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        "applies-to-tools": ["synapse-collateral__*"],
      },
      "body",
    );
    collateral.manifest.scope = "workspace";
    const crm = writeSkill(
      join(wsDir, "crm.md"),
      {
        name: "crm-skill",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        "applies-to-tools": ["synapse-crm__*"],
      },
      "body",
    );
    crm.manifest.scope = "workspace";
    runtime.conversationOverlay = [collateral, crm];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "list",
      arguments: { tool_affinity: "synapse-collateral__patch_source" },
    });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ name: string }>;
    const names = skills.map((s) => s.name);
    expect(names).toContain("collateral-skill");
    expect(names).not.toContain("crm-skill");
  });

  test("status filter excludes other statuses", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const draft = writeSkill(
      join(wsDir, "drafty.md"),
      {
        name: "drafty",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        status: "draft",
      },
      "body",
    );
    draft.manifest.scope = "workspace";
    const active = writeSkill(
      join(wsDir, "live.md"),
      { name: "live", description: "x", version: "1.0.0", type: "skill", priority: 50 },
      "body",
    );
    active.manifest.scope = "workspace";
    runtime.conversationOverlay = [draft, active];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "list", arguments: { status: "draft" } });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ name: string; status: string }>;
    expect(skills.every((s) => s.status === "draft")).toBe(true);
    expect(skills.map((s) => s.name)).toContain("drafty");
    expect(skills.map((s) => s.name)).not.toContain("live");
  });

  test("modified_since filter excludes older skills", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const skill = writeSkill(
      join(wsDir, "old.md"),
      { name: "old-skill", description: "x", version: "1.0.0", type: "skill", priority: 50 },
      "body",
    );
    skill.manifest.scope = "workspace";
    runtime.conversationOverlay = [skill];
    runtime.wsId = "ws_a";

    const future = "2099-01-01T00:00:00.000Z";
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "list",
      arguments: { modified_since: future, layer: 3 },
    });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ name: string }>;
    expect(skills.map((s) => s.name)).not.toContain("old-skill");
  });
});

// ── skills__read ─────────────────────────────────────────────────────────

describe("skills__read", () => {
  test("filesystem path → returns content + parsed metadata", async () => {
    const skillsDir = join(workDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const path = join(skillsDir, "voice.md");
    writeSkill(
      path,
      {
        name: "voice-rules",
        description: "Voice rules",
        version: "1.2.3",
        type: "context",
        priority: 25,
        "loading-strategy": "always",
      },
      "Speak plainly.",
    );

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "read", arguments: { id: path } });
    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent!;
    expect(sc.id).toBe(path);
    expect(sc.content).toContain("Speak plainly.");
    const metadata = sc.metadata as Record<string, unknown>;
    expect(metadata.name).toBe("voice-rules");
    expect(metadata.priority).toBe(25);
    expect(metadata.loadingStrategy).toBe("always");
    expect(sc.scope).toBe("platform");
    expect(sc.layer).toBe(3);
  });

  test("skill:// URI → resolves the authoring guide", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "read",
      arguments: { id: "skill://skills/authoring-guide" },
    });
    expect(result.isError).toBeFalsy();
    const sc = (result as { structuredContent?: Record<string, unknown> }).structuredContent!;
    expect(sc.layer).toBe(1);
    expect(sc.scope).toBe("bundle");
    expect((sc.metadata as { name: string }).name).toBe("authoring-guide");
    expect((sc.content as string).length).toBeGreaterThan(0);
  });

  test("rejects path-traversal attempts", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "read",
      arguments: { id: "/etc/passwd" },
    });
    expect(result.isError).toBe(true);
  });

  test("rejects relative `..` paths that resolve outside allowed roots", async () => {
    const skillsDir = join(workDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const traversal = join(skillsDir, "..", "..", "..", "etc", "passwd");
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "read", arguments: { id: traversal } });
    expect(result.isError).toBe(true);
  });

  test("returns isError for missing file under allowed root", async () => {
    const skillsDir = join(workDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const missing = join(skillsDir, "does-not-exist.md");
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "read", arguments: { id: missing } });
    expect(result.isError).toBe(true);
  });

  test("list-then-read round-trips: id from list works as input to read", async () => {
    const skillsDir = join(workDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const path = join(skillsDir, "voice.md");
    const skill = writeSkill(
      path,
      { name: "voice", description: "x", version: "1.0.0", type: "context", priority: 25 },
      "Body content",
    );
    skill.manifest.scope = "platform";
    runtime.conversationOverlay = [skill];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;

    const listResult = await client.callTool({
      name: "list",
      arguments: { scope: "platform", layer: 3 },
    });
    const listed = (listResult as { structuredContent?: { skills?: unknown[] } })
      .structuredContent?.skills as Array<{ id: string; name: string }>;
    const target = listed.find((s) => s.name === "voice")!;
    expect(target.id).toBe(path);

    const readResult = await client.callTool({
      name: "read",
      arguments: { id: target.id },
    });
    expect(readResult.isError).toBeFalsy();
    const sc = (readResult as { structuredContent?: Record<string, unknown> }).structuredContent!;
    expect(sc.content).toContain("Body content");
  });
});

// ── skills__active_for ───────────────────────────────────────────────────

describe("skills__active_for", () => {
  test("returns the most recent skills.loaded event projected to active-for shape", async () => {
    const conv = await runtime.store().create();
    runtime.store().setActiveConversation(conv.id);

    // Two skills.loaded events — the second should be the one active_for returns.
    runtime.store().emit({
      type: "skills.loaded",
      data: {
        runId: "run_old",
        skills: [
          {
            id: "/skills/old.md",
            layer: 3,
            scope: "platform",
            version: "",
            tokens: 50,
            loadedBy: "always",
            reason: "loading_strategy: always",
          },
        ],
        totalTokens: 50,
      },
    });
    runtime.store().emit({
      type: "skills.loaded",
      data: {
        runId: "run_new",
        skills: [
          {
            id: "/skills/new.md",
            layer: 3,
            scope: "workspace",
            version: "",
            tokens: 100,
            loadedBy: "tool_affinity",
            reason: "applies_to_tools matched foo__*",
          },
        ],
        totalTokens: 100,
      },
    });

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "active_for",
      arguments: { conversation_id: conv.id },
    });
    expect(result.isError).toBeFalsy();
    const active = (result as { structuredContent?: { active?: unknown[] } }).structuredContent
      ?.active as Array<{ id: string; loadedBy: string; tokens: number; reason: string }>;
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("/skills/new.md");
    expect(active[0]!.loadedBy).toBe("tool_affinity");
    expect(active[0]!.tokens).toBe(100);
    expect(active[0]!.reason).toContain("applies_to_tools matched");
  });

  test("returns empty array (not error) when no skills.loaded fired yet", async () => {
    const conv = await runtime.store().create();
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "active_for",
      arguments: { conversation_id: conv.id },
    });
    expect(result.isError).toBeFalsy();
    const active = (result as { structuredContent?: { active?: unknown[] } }).structuredContent
      ?.active as unknown[];
    expect(active).toEqual([]);
  });

  test("returns isError when conversation does not exist", async () => {
    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "active_for",
      arguments: { conversation_id: "conv_0000000000000000" },
    });
    expect(result.isError).toBe(true);
  });
});

// ── skills__loading_log ──────────────────────────────────────────────────

describe("skills__loading_log", () => {
  test("filters by conversation_id, since, until, skill_id", async () => {
    const conv = await runtime.store().create();
    runtime.store().setActiveConversation(conv.id);

    const events = [
      {
        runId: "r1",
        ts: "2026-01-01T00:00:00.000Z",
        skills: [
          {
            id: "/skills/a.md",
            layer: 3,
            scope: "platform",
            version: "",
            tokens: 10,
            loadedBy: "always",
            reason: "r",
          },
        ],
        totalTokens: 10,
      },
      {
        runId: "r2",
        ts: "2026-02-01T00:00:00.000Z",
        skills: [
          {
            id: "/skills/b.md",
            layer: 3,
            scope: "platform",
            version: "",
            tokens: 20,
            loadedBy: "always",
            reason: "r",
          },
        ],
        totalTokens: 20,
      },
      {
        runId: "r3",
        ts: "2026-03-01T00:00:00.000Z",
        skills: [
          {
            id: "/skills/a.md",
            layer: 3,
            scope: "platform",
            version: "",
            tokens: 30,
            loadedBy: "always",
            reason: "r",
          },
          {
            id: "/skills/c.md",
            layer: 3,
            scope: "user",
            version: "",
            tokens: 40,
            loadedBy: "tool_affinity",
            reason: "r",
          },
        ],
        totalTokens: 70,
      },
    ];
    for (const e of events) {
      runtime.store().appendEvent(conv.id, { type: "skills.loaded", ...e } as never);
    }

    const src = await buildSource();
    const client = src.getClient()!;

    // No filters → all three runs.
    const all = await client.callTool({
      name: "loading_log",
      arguments: { conversation_id: conv.id },
    });
    const allEvents = (all as { structuredContent?: { events?: unknown[] } }).structuredContent
      ?.events as Array<{ run_id: string }>;
    expect(allEvents.map((e) => e.run_id).sort()).toEqual(["r1", "r2", "r3"]);

    // since cuts r1.
    const sinceFeb = await client.callTool({
      name: "loading_log",
      arguments: { conversation_id: conv.id, since: "2026-02-01T00:00:00.000Z" },
    });
    const sinceEvents = (
      sinceFeb as { structuredContent?: { events?: unknown[] } }
    ).structuredContent?.events as Array<{ run_id: string }>;
    expect(sinceEvents.map((e) => e.run_id).sort()).toEqual(["r2", "r3"]);

    // until cuts r3.
    const untilJan = await client.callTool({
      name: "loading_log",
      arguments: { conversation_id: conv.id, until: "2026-02-15T00:00:00.000Z" },
    });
    const untilEvents = (
      untilJan as { structuredContent?: { events?: unknown[] } }
    ).structuredContent?.events as Array<{ run_id: string }>;
    expect(untilEvents.map((e) => e.run_id).sort()).toEqual(["r1", "r2"]);

    // skill_id matches r1 + r3 (both reference /skills/a.md).
    const onlyA = await client.callTool({
      name: "loading_log",
      arguments: { conversation_id: conv.id, skill_id: "/skills/a.md" },
    });
    const aEvents = (onlyA as { structuredContent?: { events?: unknown[] } }).structuredContent
      ?.events as Array<{ run_id: string }>;
    expect(aEvents.map((e) => e.run_id).sort()).toEqual(["r1", "r3"]);
  });

  test("workspace-wide scan (no conversation_id) walks every conv jsonl in the store dir", async () => {
    const conv1 = await runtime.store().create();
    const conv2 = await runtime.store().create();
    runtime.store().appendEvent(conv1.id, {
      type: "skills.loaded",
      ts: "2026-01-01T00:00:00.000Z",
      runId: "r1",
      skills: [],
      totalTokens: 0,
    } as never);
    runtime.store().appendEvent(conv2.id, {
      type: "skills.loaded",
      ts: "2026-02-01T00:00:00.000Z",
      runId: "r2",
      skills: [],
      totalTokens: 0,
    } as never);

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "loading_log", arguments: {} });
    const events = (result as { structuredContent?: { events?: unknown[] } }).structuredContent
      ?.events as Array<{ conv_id: string; run_id: string }>;
    const convIds = new Set(events.map((e) => e.conv_id));
    expect(convIds.has(conv1.id)).toBe(true);
    expect(convIds.has(conv2.id)).toBe(true);
  });
});
