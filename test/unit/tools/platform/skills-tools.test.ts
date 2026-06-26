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

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NoopEventSink } from "../../../../src/adapters/noop-events.ts";
import { EventSourcedConversationStore } from "../../../../src/conversation/event-sourced-store.ts";
import { ConversationLocator } from "../../../../src/conversation/locator.ts";
import { roomConversationsDir, runConversationsDir } from "../../../../src/conversation/paths.ts";
import type {
  ConversationAccessContext,
  ConversationListResult,
  ListOptions,
} from "../../../../src/conversation/types.ts";
import { parseSkillFile } from "../../../../src/skills/loader.ts";
import type { Skill } from "../../../../src/skills/types.ts";
import { runWithRequestContext } from "../../../../src/runtime/request-context.ts";
import { McpSource } from "../../../../src/tools/mcp-source.ts";
import { createSkillsSource } from "../../../../src/tools/platform/skills.ts";

// SHA-256 hex placeholder. Tests in this file exercise event projection /
// filtering / dispatch — none verify hash math, so the actual value just
// needs to be syntactically valid and stable across fixture rows.
const TEST_HASH = "0".repeat(64);

// The room the fake's seed conversations live in. Conversations are
// room-owned (`workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl`);
// every `runtime.store().create(...)` in this file seeds into this room +
// owner partition, and the facade (`resolveConversationStore` /
// `findConversation` / `listConversations`) reads them back through a real
// `ConversationLocator` over `{workDir}/workspaces`.
const SEED_WS_ID = "ws_test";
const SEED_OWNER_ID = "user_test";

// ── Fake Runtime ─────────────────────────────────────────────────────────

interface FakeIdentity {
  id: string;
}

class FakeRuntime {
  identity: FakeIdentity | null = null;
  hasIdentityProvider = false;
  wsId: string | null = null;
  private readonly _store: EventSourcedConversationStore;
  private readonly _locator: ConversationLocator;

  contextSkills: Skill[] = [];
  matchableSkills: Skill[] = [];
  conversationOverlay: Skill[] = [];

  constructor(private workDir: string) {
    // Back the fake with a real locator over the workspaces root and a real
    // room store, so the conversation facade (`resolveConversationStore` /
    // `findConversation` / `listConversations`) is exercised end-to-end
    // against the room-partitioned on-disk layout.
    this._locator = new ConversationLocator(join(workDir, "workspaces"));
    const convDir = roomConversationsDir(workDir, SEED_WS_ID, SEED_OWNER_ID);
    mkdirSync(convDir, { recursive: true });
    this._store = new EventSourcedConversationStore({
      dir: convDir,
      onMutate: () => this._locator.invalidate(),
    });
  }

  getWorkDir(): string {
    return this.workDir;
  }
  getCurrentIdentity(): FakeIdentity | null {
    return this.identity;
  }
  getIdentityProvider(): object | null {
    return this.hasIdentityProvider ? ({} as object) : null;
  }
  requireWorkspaceId(): string {
    if (!this.wsId) throw new Error("no workspace");
    return this.wsId;
  }
  /** Resolve the room store holding `convId` via the locator (null if unknown). */
  async resolveConversationStore(convId: string): Promise<EventSourcedConversationStore | null> {
    const loc = await this._locator.locate(convId);
    if (!loc) return null;
    return new EventSourcedConversationStore({
      dir: loc.automationId
        ? runConversationsDir(this.workDir, loc.wsId, loc.automationId)
        : roomConversationsDir(this.workDir, loc.wsId, loc.ownerId ?? ""),
    });
  }
  async findConversation(id: string, access?: ConversationAccessContext): Promise<unknown> {
    const store = await this.resolveConversationStore(id);
    if (!store) return null;
    return store.load(id, access);
  }
  async listConversations(
    options?: ListOptions,
    access?: ConversationAccessContext,
  ): Promise<ConversationListResult> {
    return this._locator.list(options, access);
  }
  getWorkspaceStore() {
    // Tests that exercise the cross-workspace path supply this directly
    // by patching it. Default returns null for everything → access
    // checks fail gracefully when a test forgets to set up membership.
    return {
      get: async (_id: string) => null,
    };
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
  const yaml = serializeYaml(toNestedFrontmatter(frontmatter));
  writeFileSync(path, `---\n${yaml}---\n\n${body}\n`);
  const parsed = parseSkillFile(path);
  if (!parsed) throw new Error(`Failed to parse fixture skill at ${path}`);
  return parsed;
}

/**
 * Translate the legacy flat fixture shape (top-level `type`/`priority`/
 * `applies-to-tools`/…) into the canonical on-disk shape: standard fields
 * top-level, NimbleBrain config nested under `metadata.nimblebrain.*`. Lets the
 * existing fixtures keep their terse flat form while exercising the new loader.
 */
function toNestedFrontmatter(flat: Record<string, unknown>): Record<string, unknown> {
  const fm: Record<string, unknown> = { name: flat.name, description: flat.description };
  if (flat.license) fm.license = flat.license;
  if (flat.compatibility) fm.compatibility = flat.compatibility;
  const allowed = flat["allowed-tools"] ?? flat.allowedTools;
  if (Array.isArray(allowed)) fm["allowed-tools"] = allowed.join(" ");
  else if (typeof allowed === "string") fm["allowed-tools"] = allowed;

  const nb: Record<string, unknown> = {};
  let ls = flat["loading-strategy"] ?? flat.loading_strategy ?? flat.loadingStrategy;
  if (ls === "tool_affined") ls = "dynamic";
  if (!ls) ls = flat.type === "context" ? "always" : "dynamic";
  nb["loading-strategy"] = ls;
  if (flat.priority !== undefined) nb.priority = flat.priority;
  if (flat.status !== undefined) nb.status = flat.status;
  const aff = flat["applies-to-tools"] ?? flat.applies_to_tools ?? flat.appliesToTools;
  if (Array.isArray(aff) && aff.length > 0) nb["tool-affinity"] = aff;
  const meta = (flat.metadata ?? {}) as Record<string, unknown>;
  const triggers = flat.triggers ?? meta.triggers;
  if (Array.isArray(triggers) && triggers.length > 0) nb.triggers = triggers;
  fm.metadata = { nimblebrain: nb };
  return fm;
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
  // Default identity matches the `ownerId: "user_test"` used by every
  // `runtime.store().create({...})` call in this file. Stage 1 single-
  // owner means tools that read conversation events require the caller
  // to own the conversation; this seeds that match for the happy path.
  // Tests that need to assert ownership-mismatch should override.
  runtime.identity = { id: "user_test" };
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

  test("empty tool_affinity matches nothing (does not silently match all wildcard skills)", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    // A skill whose applies-to-tools = ["*"] would naively match an empty
    // target — verify the handler short-circuits before that.
    const wildcard = writeSkill(
      join(wsDir, "wild.md"),
      {
        name: "wildcard-skill",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        "applies-to-tools": ["*"],
      },
      "body",
    );
    wildcard.manifest.scope = "workspace";
    runtime.conversationOverlay = [wildcard];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({
      name: "list",
      arguments: { tool_affinity: "" },
    });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ name: string }>;
    expect(skills.map((s) => s.name)).not.toContain("wildcard-skill");
  });

  test("status filter excludes other statuses", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const disabled = writeSkill(
      join(wsDir, "off.md"),
      {
        name: "off-skill",
        description: "x",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        status: "disabled",
      },
      "body",
    );
    disabled.manifest.scope = "workspace";
    const active = writeSkill(
      join(wsDir, "live.md"),
      { name: "live", description: "x", version: "1.0.0", type: "skill", priority: 50 },
      "body",
    );
    active.manifest.scope = "workspace";
    runtime.conversationOverlay = [disabled, active];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "list", arguments: { status: "disabled" } });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{ name: string; status: string }>;
    expect(skills.every((s) => s.status === "disabled")).toBe(true);
    expect(skills.map((s) => s.name)).toContain("off-skill");
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

  // ── loading-visibility field (issue #391) ───────────────────────────────

  test("dead type: skill (no strategy/triggers) reports loading.wouldLoad=false / mechanism=none", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    // No loading-strategy, no triggers, no applies-to-tools → reaches no
    // loader path. This is the silently-inert population issue #391 targets.
    const dead = writeSkill(
      join(wsDir, "dead.md"),
      { name: "dead-skill", description: "inert", version: "1.0.0", type: "skill", priority: 50 },
      "body",
    );
    dead.manifest.scope = "workspace";
    runtime.conversationOverlay = [dead];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "list", arguments: { layer: 3 } });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{
      name: string;
      loading?: { wouldLoad: boolean; mechanism: string };
    }>;
    const row = skills.find((s) => s.name === "dead-skill")!;
    expect(row.loading).toEqual({ wouldLoad: false, mechanism: "none" });

    // The model-visible content carries the warning marker.
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("⚠ never loads");
  });

  test("loadable skill reports loading.wouldLoad=true with the correct mechanism", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const live = writeSkill(
      join(wsDir, "live.md"),
      {
        name: "live-skill",
        description: "loads always",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        "loading-strategy": "always",
      },
      "body",
    );
    live.manifest.scope = "workspace";
    runtime.conversationOverlay = [live];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "list", arguments: { layer: 3 } });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{
      name: string;
      loading?: { wouldLoad: boolean; mechanism: string };
    }>;
    const row = skills.find((s) => s.name === "live-skill")!;
    expect(row.loading).toEqual({ wouldLoad: true, mechanism: "always" });

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).not.toContain("⚠ never loads");
  });

  test("trigger skill reports mechanism=trigger; vendored guide reports always", async () => {
    const wsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(wsDir, { recursive: true });
    const trig = writeSkill(
      join(wsDir, "trig.md"),
      {
        name: "trigger-skill",
        description: "rides the matcher",
        version: "1.0.0",
        type: "skill",
        priority: 50,
        metadata: { triggers: ["deploy"] },
      },
      "body",
    );
    trig.manifest.scope = "workspace";
    runtime.conversationOverlay = [trig];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "list", arguments: {} });
    const skills = (result as { structuredContent?: { skills?: unknown[] } }).structuredContent
      ?.skills as Array<{
      name: string;
      loading?: { wouldLoad: boolean; mechanism: string };
    }>;
    expect(skills.find((s) => s.name === "trigger-skill")!.loading).toEqual({
      wouldLoad: true,
      mechanism: "trigger",
    });
    // Layer-1 vendored authoring guide declares applies-to-tools (skills__*),
    // so it resolves to tool_affinity — and is always loadable.
    expect(skills.find((s) => s.name === "authoring-guide")!.loading).toEqual({
      wouldLoad: true,
      mechanism: "tool_affinity",
    });
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
    expect(sc.scope).toBe("org");
    expect(sc.layer).toBe(3);

    // The model-visible `content` text (not just `structuredContent`, which
    // the engine never surfaces to the model) must carry the body and the
    // promised manifest fields. Manifest leads, body trails after `---`.
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
    expect(text).toContain("voice-rules");
    expect(text).toContain("loads: always");
    expect(text).toContain("priority: 25");
    // `status` is promised by the description and must render even for an
    // active skill (the default) — not only when non-active.
    expect(text).toContain("status: active");
    expect(text).toContain("Speak plainly.");
    expect(text.indexOf("priority: 25")).toBeLessThan(text.indexOf("Speak plainly."));
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

  test("rejects symlinks that escape allowed roots", async () => {
    // A writer with access to the workspace skills dir drops a symlink
    // pointing at /etc/passwd. The lexical under-root check passes because
    // the link itself sits under an allowed root; the realpath check is
    // what catches the escape.
    const skillsDir = join(workDir, "workspaces", "ws_a", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Write a real file outside the roots.
    const outsideDir = mkdtempSync(join(tmpdir(), "skills-outside-"));
    const outsidePath = join(outsideDir, "secret.md");
    writeFileSync(
      outsidePath,
      ["---", "name: secret", "type: skill", "priority: 50", "---", "secret body", ""].join("\n"),
    );
    const linkPath = join(skillsDir, "evil.md");
    symlinkSync(outsidePath, linkPath);

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await client.callTool({ name: "read", arguments: { id: linkPath } });
    expect(result.isError).toBe(true);
    rmSync(outsideDir, { recursive: true, force: true });
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
    skill.manifest.scope = "org";
    runtime.conversationOverlay = [skill];
    runtime.wsId = "ws_a";

    const src = await buildSource();
    const client = src.getClient()!;

    const listResult = await client.callTool({
      name: "list",
      arguments: { scope: "org", layer: 3 },
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
    const conv = await runtime.store().create({ ownerId: "user_test" });
    // setActiveConversation routes the subsequent emit() calls into conv's
    // event log (the store appends to whatever conversation is "active" at
    // emit time — see event-sourced-store.ts:appendEvent). The active_for
    // handler queries by id, not by active-conv, but the test fixtures
    // need this to land the events somewhere readable.
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
            scope: "org",
            version: "",
            tokens: 50,
            contentHash: TEST_HASH,
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
            contentHash: TEST_HASH,
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
    const conv = await runtime.store().create({ ownerId: "user_test" });
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

  test("defaults to current conversation from request context when conversation_id omitted", async () => {
    // Inside a chat the agent doesn't know its own conv id. The handler
    // reads it from RequestContext when input.conversation_id is missing.
    const conv = await runtime.store().create({ ownerId: "user_test" });
    runtime.store().setActiveConversation(conv.id);
    runtime.store().emit({
      type: "skills.loaded",
      data: {
        runId: "run_in_ctx",
        skills: [
          {
            id: "/skills/from-ctx.md",
            layer: 3,
            scope: "org",
            version: "",
            tokens: 42,
            loadedBy: "always",
            reason: "loading_strategy: always",
          },
        ],
        totalTokens: 42,
      },
    });

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await runWithRequestContext(
      {
        identity: null,
        scope: { kind: "identity" },
        conversationId: conv.id,
      },
      () => client.callTool({ name: "active_for", arguments: {} }),
    );
    expect(result.isError).toBeFalsy();
    const sc = (
      result as { structuredContent?: { active?: unknown[]; conversationId?: string } }
    ).structuredContent;
    expect(sc?.conversationId).toBe(conv.id);
    const active = sc?.active as Array<{ id: string }>;
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("/skills/from-ctx.md");
  });

  test("explicit conversation_id wins over request context", async () => {
    // If the agent passes an explicit id, honor it — even if a different
    // conv is in the request context. Lets the agent inspect a sibling
    // conversation it has access to.
    const ctxConv = await runtime.store().create({ ownerId: "user_test" });
    const argConv = await runtime.store().create({ ownerId: "user_test" });
    runtime.store().setActiveConversation(argConv.id);
    runtime.store().emit({
      type: "skills.loaded",
      data: {
        runId: "run_arg",
        skills: [
          {
            id: "/skills/from-arg.md",
            layer: 3,
            scope: "org",
            version: "",
            tokens: 10,
            loadedBy: "always",
            reason: "loading_strategy: always",
          },
        ],
        totalTokens: 10,
      },
    });

    const src = await buildSource();
    const client = src.getClient()!;
    const result = await runWithRequestContext(
      {
        identity: null,
        scope: { kind: "identity" },
        conversationId: ctxConv.id,
      },
      () =>
        client.callTool({
          name: "active_for",
          arguments: { conversation_id: argConv.id },
        }),
    );
    expect(result.isError).toBeFalsy();
    const sc = (
      result as { structuredContent?: { active?: unknown[]; conversationId?: string } }
    ).structuredContent;
    expect(sc?.conversationId).toBe(argConv.id);
    // skills.loaded was emitted against argConv only — the returned skill
    // proves the handler queried argConv, not just echoed the input id back.
    // (If the handler bug-queried ctxConv, active would be empty.)
    const active = sc?.active as Array<{ id: string }>;
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("/skills/from-arg.md");
  });
});

// ── skills__loading_log ──────────────────────────────────────────────────

describe("skills__loading_log", () => {
  test("filters by conversation_id, since, until, skill_id", async () => {
    const conv = await runtime.store().create({ ownerId: "user_test" });
    runtime.store().setActiveConversation(conv.id);

    const events = [
      {
        runId: "r1",
        ts: "2026-01-01T00:00:00.000Z",
        skills: [
          {
            id: "/skills/a.md",
            layer: 3,
            scope: "org",
            version: "",
            tokens: 10,
            contentHash: TEST_HASH,
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
            scope: "org",
            version: "",
            tokens: 20,
            contentHash: TEST_HASH,
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
            scope: "org",
            version: "",
            tokens: 30,
            contentHash: TEST_HASH,
            loadedBy: "always",
            reason: "r",
          },
          {
            id: "/skills/c.md",
            layer: 3,
            scope: "user",
            version: "",
            tokens: 40,
            contentHash: TEST_HASH,
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
    const conv1 = await runtime.store().create({ ownerId: "user_test" });
    const conv2 = await runtime.store().create({ ownerId: "user_test" });
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
