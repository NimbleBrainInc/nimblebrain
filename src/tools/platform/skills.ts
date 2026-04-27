/**
 * Skills platform source — in-process MCP server.
 *
 * Owns Phase 2 read-only Layer 3 (cross-bundle agent orchestration) skill
 * visibility plus a single Layer 1 vendored resource: the platform-authored
 * guide for writing good skills. Mirrors `instructions.ts` structurally.
 *
 * Tools surfaced (read-only):
 *   skills__list           — enumerate skills with scope/layer/status filters
 *   skills__read           — fetch one skill's body + manifest by id
 *   skills__active_for     — show which skills loaded for a conversation
 *   skills__loading_log    — replay skills.loaded events for analysis
 *
 * Resource surfaced:
 *   skill://skills/authoring-guide — Layer 1 vendored markdown
 *
 * Mutation tools (create/update/delete/activate/etc.) are Phase 3 — see the
 * comment block at the bottom of this file for the intended surface so the
 * next implementer registers them in the right place.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventSourcedConversationStore } from "../../conversation/event-sourced-store.ts";
import type { ConversationEvent, SkillsLoadedEvent } from "../../conversation/types.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { parseSkillFile, readSkillMtime } from "../../skills/loader.ts";
import { toolMatches } from "../../skills/select.ts";
import type { Skill } from "../../skills/types.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";

// ── Source name ──────────────────────────────────────────────────────────

/** Source name — keep stable; tools surface as `skills__list`, etc. */
export const SKILLS_SOURCE_NAME = "skills";

// ── Constants ────────────────────────────────────────────────────────────

const SKILL_URI_PREFIX = "skill://";
const AUTHORING_GUIDE_URI = "skill://skills/authoring-guide";

// ── Tool descriptions (description-as-policy) ────────────────────────────

const SKILLS_LIST_DESCRIPTION =
  "List Layer 3 skills (cross-bundle agent orchestration content) and Layer 1 vendored bundle skills. " +
  "Filter by `scope` (platform | workspace | user | bundle), `layer` (1 | 3), `type` (context | skill), " +
  "`tool_affinity` (a tool name; returns skills whose `applies_to_tools` glob matches it), " +
  "`status` (active | draft | disabled | archived), or `modified_since` (ISO 8601). " +
  "Returns id, name, layer, scope, status, token count, and source metadata for each skill. " +
  "Use this to answer 'what skills do I have?' or 'what's available for the active tool set?'";

const SKILLS_READ_DESCRIPTION =
  "Read one skill by id (filesystem path or `skill://` URI). " +
  "Returns the markdown body plus parsed manifest fields (name, description, version, type, " +
  "priority, scope, layer, loading_strategy, applies_to_tools, status, allowed_tools, " +
  "requires_bundles, metadata). Use after `skills__list` to inspect a specific skill before " +
  "answering questions about it or proposing changes.";

const SKILLS_ACTIVE_FOR_DESCRIPTION =
  "Show which Layer 3 skills are currently loaded for the conversation `conversation_id`. " +
  "Returns one entry per loaded skill with id, layer, scope, token count, `loadedBy` " +
  "(`always` or `tool_affinity`), and a human-readable `reason`. " +
  "Use this to answer 'what's active for this conversation right now?' — distinct from `skills__list` " +
  "which enumerates the catalog regardless of load state.";

const SKILLS_LOADING_LOG_DESCRIPTION =
  "Replay `skills.loaded` events from conversation logs. Filter by `conversation_id`, `skill_id`, " +
  "and a `since`/`until` ISO 8601 window. Returns one entry per run with timestamp, conversation id, " +
  "run id, the skills loaded for that run, total tokens, and the active tool set at the time. " +
  "Use to audit which skills fired across a window of activity, or to debug why a particular skill " +
  "did or did not load.";

// ── Source factory ───────────────────────────────────────────────────────

/**
 * Create the skills platform source.
 *
 * The `eventSink` parameter is currently unused but kept on the signature to
 * mirror `createInstructionsSource` and reserve the wiring for Phase 3
 * mutation tools, which will emit `skill.created` / `skill.updated` /
 * `skill.deleted` engine events.
 */
export function createSkillsSource(runtime: Runtime, eventSink: EventSink): McpSource {
  // Layer 1 vendored guide lives next to the loader's `builtin/` directory.
  // Read at handler time (not module init) so the file can be replaced
  // without a process restart.
  const authoringGuidePath = join(
    import.meta.dirname ?? __dirname,
    "../../skills/builtin/authoring-guide.md",
  );

  const tools: InProcessTool[] = [
    {
      name: "list",
      description: SKILLS_LIST_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["platform", "workspace", "user", "bundle"],
            description: "Filter to a single tier of the skill catalog.",
          },
          layer: {
            type: "number",
            enum: [1, 3],
            description: "Filter to Layer 1 (vendored) or Layer 3 (orchestration) skills.",
          },
          type: {
            type: "string",
            description: "Filter by manifest `type` (e.g. `context`, `skill`).",
          },
          tool_affinity: {
            type: "string",
            description:
              "A tool name; returns only skills whose `applies_to_tools` glob matches it.",
          },
          status: {
            type: "string",
            enum: ["active", "draft", "disabled", "archived"],
            description: "Filter by lifecycle status. Defaults to all statuses when omitted.",
          },
          modified_since: {
            type: "string",
            description: "ISO 8601 timestamp; only skills modified at or after this are returned.",
          },
        },
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const list = await listSkills(runtime, authoringGuidePath, input);
          return {
            content: textContent(JSON.stringify(list)),
            structuredContent: { skills: list },
            isError: false,
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "read",
      description: SKILLS_READ_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Skill identifier — filesystem path or `skill://` URI.",
          },
        },
        required: ["id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const id = String(input.id ?? "");
          const result = await readSkillById(runtime, authoringGuidePath, id);
          if (!result) {
            return {
              content: textContent(JSON.stringify({ error: `Skill not found: ${id}` })),
              isError: true,
            };
          }
          return {
            content: textContent(JSON.stringify(result)),
            structuredContent: result as unknown as Record<string, unknown>,
            isError: false,
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "active_for",
      description: SKILLS_ACTIVE_FOR_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: {
            type: "string",
            description: "Conversation id whose loaded-skill state is being inspected.",
          },
        },
        required: ["conversation_id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const convId = String(input.conversation_id ?? "");
          const result = await activeForConversation(runtime, convId);
          if (result === null) {
            return {
              content: textContent(JSON.stringify({ error: `Conversation not found: ${convId}` })),
              isError: true,
            };
          }
          return {
            content: textContent(JSON.stringify(result)),
            structuredContent: { active: result },
            isError: false,
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "loading_log",
      description: SKILLS_LOADING_LOG_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: {
            type: "string",
            description: "Filter to a single conversation id.",
          },
          skill_id: {
            type: "string",
            description: "Filter to runs that loaded this specific skill id.",
          },
          since: {
            type: "string",
            description: "ISO 8601 lower bound (inclusive).",
          },
          until: {
            type: "string",
            description: "ISO 8601 upper bound (inclusive).",
          },
        },
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const events = await loadingLog(runtime, input);
          return {
            content: textContent(JSON.stringify(events)),
            structuredContent: { events },
            isError: false,
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    },
  ];

  // Layer 1 vendored authoring guide. Callback-form `text` so the file is
  // re-read on every `resources/read`.
  const resources = new Map<string, { text: () => Promise<string>; mimeType: string }>([
    [
      AUTHORING_GUIDE_URI,
      {
        mimeType: "text/markdown",
        text: async () => {
          if (existsSync(authoringGuidePath)) {
            return readFileSync(authoringGuidePath, "utf-8");
          }
          return "# Authoring Guide\n\n(content pending — see Task 005 in .tasks/skills-phase2/)\n";
        },
      },
    ],
  ]);

  return defineInProcessApp(
    {
      name: SKILLS_SOURCE_NAME,
      version: "1.0.0",
      tools,
      resources,
    },
    eventSink,
  );
}

// ── Internal handler logic ───────────────────────────────────────────────

interface ListInput {
  scope?: string;
  layer?: number;
  type?: string;
  tool_affinity?: string;
  status?: string;
  modified_since?: string;
}

interface ListedSkill {
  id: string;
  name: string;
  layer: 1 | 3;
  scope: "platform" | "workspace" | "user" | "bundle";
  status: "active" | "draft" | "disabled" | "archived";
  type?: string;
  tokens: number;
  source: { bundle?: string; bundleVersion?: string; path?: string; uri?: string };
  description?: string;
  modifiedAt?: string;
  loadingStrategy?: string;
  appliesToTools?: string[];
  priority?: number;
}

interface ReadResult {
  id: string;
  content: string;
  layer: 1 | 3;
  scope: "platform" | "workspace" | "user" | "bundle";
  source: { bundle?: string; bundleVersion?: string; path?: string; uri?: string };
  metadata: {
    name: string;
    description?: string;
    type?: string;
    priority?: number;
    loadingStrategy?: string;
    appliesToTools?: string[];
    status?: string;
    overrides?: Array<{ bundle?: string; skill?: string; reason: string }>;
    derivedFrom?: string;
  };
  modifiedAt?: string;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function skillToListed(skill: Skill): ListedSkill {
  const m = skill.manifest;
  const path = skill.sourcePath || undefined;
  const id = path || `skill-in-memory:${m.name}`;
  return {
    id,
    name: m.name,
    layer: 3,
    scope: m.scope ?? "platform",
    status: m.status ?? "active",
    type: m.type,
    tokens: approxTokens(skill.body),
    source: path ? { path } : {},
    ...(m.description ? { description: m.description } : {}),
    ...(path ? { modifiedAt: readSkillMtime(path) } : {}),
    ...(m.loadingStrategy ? { loadingStrategy: m.loadingStrategy } : {}),
    ...(m.appliesToTools && m.appliesToTools.length > 0
      ? { appliesToTools: m.appliesToTools }
      : {}),
    priority: m.priority,
  };
}

/**
 * Best-effort workspace + user resolution from the runtime. Falls back to
 * platform-only when the runtime has no workspace context (e.g. tool called
 * outside an active conversation).
 */
function resolveCallContext(runtime: Runtime): { wsId: string | null; userId: string | null } {
  let wsId: string | null = null;
  try {
    wsId = runtime.requireWorkspaceId();
  } catch {
    wsId = null;
  }
  const identity = runtime.getCurrentIdentity();
  const userId = identity?.id ?? null;
  return { wsId, userId };
}

async function listSkills(
  runtime: Runtime,
  authoringGuidePath: string,
  input: Record<string, unknown>,
): Promise<ListedSkill[]> {
  const filter = input as ListInput;

  const out: ListedSkill[] = [];
  const includeLayer3 = filter.layer === undefined || filter.layer === 3;
  const includeLayer1 = filter.layer === undefined || filter.layer === 1;

  // Layer 3: discovered via the runtime's per-conversation overlay (or the
  // platform-only static pool when there's no workspace context).
  if (includeLayer3) {
    const { wsId, userId } = resolveCallContext(runtime);
    const skills = wsId
      ? runtime.loadConversationSkills(wsId, userId)
      : runtime.getContextSkills().concat(runtime.getMatchableSkills());
    for (const skill of skills) {
      out.push(skillToListed(skill));
    }
  }

  // Layer 1: vendored bundle resources. Phase 2 surfaces only the platform-
  // authored authoring guide (`skill://skills/authoring-guide`). Future
  // bundles that publish their own `skill://...` resources will be
  // discovered via a runtime resource scan; for Phase 2 the catalog is
  // static and small.
  if (includeLayer1) {
    if (existsSync(authoringGuidePath)) {
      const skill = parseSkillFile(authoringGuidePath);
      if (skill) {
        const tokens = approxTokens(skill.body);
        out.push({
          id: AUTHORING_GUIDE_URI,
          name: skill.manifest.name,
          layer: 1,
          scope: "bundle",
          status: skill.manifest.status ?? "active",
          type: skill.manifest.type,
          tokens,
          source: { uri: AUTHORING_GUIDE_URI, path: authoringGuidePath, bundle: "nb__skills" },
          ...(skill.manifest.description ? { description: skill.manifest.description } : {}),
          modifiedAt: readSkillMtime(authoringGuidePath),
          ...(skill.manifest.loadingStrategy
            ? { loadingStrategy: skill.manifest.loadingStrategy }
            : {}),
          ...(skill.manifest.appliesToTools && skill.manifest.appliesToTools.length > 0
            ? { appliesToTools: skill.manifest.appliesToTools }
            : {}),
          priority: skill.manifest.priority,
        });
      }
    }
  }

  // Apply scalar filters
  return out.filter((s) => {
    if (filter.scope && s.scope !== filter.scope) return false;
    if (filter.type && s.type !== filter.type) return false;
    if (filter.status && s.status !== filter.status) return false;
    if (filter.modified_since && s.modifiedAt) {
      if (s.modifiedAt < filter.modified_since) return false;
    }
    if (filter.tool_affinity) {
      const patterns = s.appliesToTools ?? [];
      if (patterns.length === 0) return false;
      const target = filter.tool_affinity;
      if (!patterns.some((p) => toolMatches(target, p))) return false;
    }
    return true;
  });
}

/**
 * Resolve every directory a skill is allowed to be read from. Used by
 * `skills__read` to reject path traversal — the requested filesystem path
 * must resolve under one of these roots.
 */
function allowedReadRoots(runtime: Runtime, authoringGuidePath: string): string[] {
  const workDir = runtime.getWorkDir();
  const roots = [
    join(workDir, "skills"),
    join(workDir, "workspaces"),
    join(workDir, "users"),
    // Built-in skills directory (Layer 1 + core).
    resolve(authoringGuidePath, ".."), // src/skills/builtin
    resolve(authoringGuidePath, "../../core"), // src/skills/core
  ];
  return roots.map((r) => resolve(r));
}

function isPathUnderAnyRoot(target: string, roots: string[]): boolean {
  const resolved = resolve(target);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

async function readSkillById(
  runtime: Runtime,
  authoringGuidePath: string,
  id: string,
): Promise<ReadResult | null> {
  if (!id) return null;

  // Dispatch by id scheme.
  if (id === AUTHORING_GUIDE_URI || id.startsWith(SKILL_URI_PREFIX)) {
    if (id !== AUTHORING_GUIDE_URI) {
      // Phase 2 only exposes the one Layer 1 resource by URI.
      return null;
    }
    if (!existsSync(authoringGuidePath)) return null;
    const skill = parseSkillFile(authoringGuidePath);
    if (!skill) return null;
    return buildReadResult(skill, {
      id,
      layer: 1,
      scope: "bundle",
      source: { uri: id, path: authoringGuidePath, bundle: "nb__skills" },
      modifiedAt: readSkillMtime(authoringGuidePath),
    });
  }

  // Treat as filesystem path. Reject path-traversal: must resolve under one
  // of the allowed roots.
  const roots = allowedReadRoots(runtime, authoringGuidePath);
  if (!isPathUnderAnyRoot(id, roots)) {
    throw new Error(
      `Skill path "${id}" is not under any allowed root (platform/workspace/user/builtin)`,
    );
  }

  if (!existsSync(id)) return null;
  const skill = parseSkillFile(id);
  if (!skill) return null;
  return buildReadResult(skill, {
    id,
    layer: 3,
    scope: skill.manifest.scope ?? inferScopeFromPath(id, runtime.getWorkDir()),
    source: { path: id },
    modifiedAt: readSkillMtime(id),
  });
}

function buildReadResult(
  skill: Skill,
  base: {
    id: string;
    layer: 1 | 3;
    scope: "platform" | "workspace" | "user" | "bundle";
    source: ReadResult["source"];
    modifiedAt?: string;
  },
): ReadResult {
  const m = skill.manifest;
  return {
    id: base.id,
    content: skill.body,
    layer: base.layer,
    scope: base.scope,
    source: base.source,
    metadata: {
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
      type: m.type,
      priority: m.priority,
      ...(m.loadingStrategy ? { loadingStrategy: m.loadingStrategy } : {}),
      ...(m.appliesToTools && m.appliesToTools.length > 0
        ? { appliesToTools: m.appliesToTools }
        : {}),
      status: m.status ?? "active",
      ...(m.overrides && m.overrides.length > 0 ? { overrides: m.overrides } : {}),
      ...(m.derivedFrom ? { derivedFrom: m.derivedFrom } : {}),
    },
    ...(base.modifiedAt ? { modifiedAt: base.modifiedAt } : {}),
  };
}

function inferScopeFromPath(
  path: string,
  workDir: string,
): "platform" | "workspace" | "user" | "bundle" {
  const resolved = resolve(path);
  if (resolved.startsWith(`${resolve(workDir, "workspaces")}/`)) return "workspace";
  if (resolved.startsWith(`${resolve(workDir, "users")}/`)) return "user";
  return "platform";
}

interface ActiveForEntry {
  id: string;
  layer: 3;
  scope: "platform" | "workspace" | "user" | "bundle";
  tokens: number;
  loadedBy: "always" | "tool_affinity";
  reason: string;
}

/**
 * Find the most recent `skills.loaded` event for the conversation and
 * return its `skills[]` projected to the active-for output shape. Returns
 * `null` if the conversation cannot be found, `[]` if no `skills.loaded`
 * has fired yet for that conversation.
 */
async function activeForConversation(
  runtime: Runtime,
  convId: string,
): Promise<ActiveForEntry[] | null> {
  const events = await readConvEvents(runtime, convId);
  if (events === null) return null;

  // Walk from the end to find the most recent skills.loaded.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === "skills.loaded") {
      return (ev as SkillsLoadedEvent).skills.map((s) => ({
        id: s.id,
        layer: 3 as const,
        scope: (s.scope ?? "platform") as ActiveForEntry["scope"],
        tokens: s.tokens,
        loadedBy: s.loadedBy,
        reason: s.reason,
      }));
    }
  }
  return [];
}

interface LoadingLogEntry {
  ts: string;
  conv_id: string;
  run_id: string;
  loaded: SkillsLoadedEvent["skills"];
  total_tokens: number;
}

interface LoadingLogInput {
  conversation_id?: string;
  skill_id?: string;
  since?: string;
  until?: string;
}

/**
 * Replay `skills.loaded` events. When `conversation_id` is provided, scan
 * just that conversation; otherwise scan every conversation in the active
 * workspace's store. The cross-conv scan reads each jsonl in turn — this
 * is intentionally simple for Phase 2; a derived index lands in Phase 6.
 */
async function loadingLog(
  runtime: Runtime,
  input: Record<string, unknown>,
): Promise<LoadingLogEntry[]> {
  const filter = input as LoadingLogInput;

  const convIds: string[] = [];
  if (filter.conversation_id) {
    convIds.push(filter.conversation_id);
  } else {
    convIds.push(...listWorkspaceConversationIds(runtime));
  }

  const out: LoadingLogEntry[] = [];
  for (const convId of convIds) {
    const events = await readConvEvents(runtime, convId);
    if (!events) continue;
    for (const ev of events) {
      if (ev.type !== "skills.loaded") continue;
      const sl = ev as SkillsLoadedEvent;
      if (filter.since && sl.ts < filter.since) continue;
      if (filter.until && sl.ts > filter.until) continue;
      if (filter.skill_id && !sl.skills.some((s) => s.id === filter.skill_id)) continue;
      out.push({
        ts: sl.ts,
        conv_id: convId,
        run_id: sl.runId,
        loaded: sl.skills,
        total_tokens: sl.totalTokens,
      });
    }
  }
  // Sort by timestamp for stable ordering across conversations.
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

/**
 * Read raw conversation events for the given id from the active store.
 *
 * Resolves through `runtime.getConversationStore()` when possible (the
 * Phase 1 abstraction); falls back to instantiating an
 * EventSourcedConversationStore on the workspace conversation dir when the
 * runtime hasn't bound one (e.g. the legacy global path during tests).
 *
 * Returns `null` for not-found, `[]` for legacy (message-format)
 * conversations.
 */
async function readConvEvents(
  runtime: Runtime,
  convId: string,
): Promise<ConversationEvent[] | null> {
  const store = getEventStore(runtime);
  if (!store) return null;
  if (!conversationFileExists(store, convId)) return null;
  return store.readEvents(convId);
}

function getEventStore(runtime: Runtime): EventSourcedConversationStore | null {
  // The runtime exposes a `ConversationStore` interface; for Phase 2 the
  // event-sourced store is the only one with `readEvents`. Try the
  // workspace-scoped store first; fall back to constructing one on the
  // global workDir/conversations path.
  let raw: unknown;
  try {
    raw = runtime.getConversationStore();
  } catch {
    raw = null;
  }
  if (raw instanceof EventSourcedConversationStore) return raw;

  // Fallback: a default event-sourced store rooted at the global workDir.
  const workDir = runtime.getWorkDir();
  const dir = join(workDir, "conversations");
  if (!existsSync(dir)) return null;
  return new EventSourcedConversationStore({ dir });
}

function conversationFileExists(store: EventSourcedConversationStore, convId: string): boolean {
  try {
    statSync(join(store.getDir(), `${convId}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

function listWorkspaceConversationIds(runtime: Runtime): string[] {
  const store = getEventStore(runtime);
  if (!store) return [];
  const dir = store.getDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  } catch {
    return [];
  }
}

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: textContent(JSON.stringify({ error: message })),
    isError: true,
  };
}

// ── Future Phase 3 mutation tools ────────────────────────────────────────
//
// The following tools are designed but NOT registered in Phase 2. They land
// in subsequent phases and will be added to the `tools` array above:
//
//   skills__create        — create a new skill (write to the appropriate scope dir)
//   skills__update        — update an existing skill body or manifest
//   skills__delete        — delete a skill (Phase 3 — versioning lands with this)
//   skills__activate      — flip status: draft|disabled → active
//   skills__deactivate    — flip status: active → disabled
//   skills__move_scope    — relocate a skill across platform/workspace/user
//   skills__author        — agent-driven authoring flow (Phase 4)
//   skills__commit_draft  — promote an authored draft to active (Phase 4)
//   skills__lint          — auditor agent lint pass (Phase 4)
//   skills__attribution   — attribution surface (Phase 5)
//
// When adding any of these, mirror the read-tool shape: production-quality
// description, JSON Schema input, structured `ToolResult` returns, role gates
// (admin-only for platform-scope writes; workspace-admin or org-admin for
// workspace-scope writes; self for user-scope writes — see permissions table
// in SPEC_REFERENCE.md).
