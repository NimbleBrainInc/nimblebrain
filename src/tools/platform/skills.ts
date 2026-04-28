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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EventSourcedConversationStore } from "../../conversation/event-sourced-store.ts";
import type { ConversationEvent, SkillsLoadedEvent } from "../../conversation/types.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { parseSkillFile, readSkillMtime } from "../../skills/loader.ts";
import { coerceManifestInput, coerceManifestPatch } from "../../skills/manifest-input.ts";
import { toolMatches } from "../../skills/select.ts";
import { approxTokens } from "../../skills/tokens.ts";
import type { Skill } from "../../skills/types.ts";
import { validateSkill } from "../../skills/validator.ts";
import { deleteSkill, updateSkill, writeSkill } from "../../skills/writer.ts";
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

const SKILLS_CREATE_DESCRIPTION =
  "Create a new Layer 3 skill at the given scope (`platform`, `workspace`, or `user`). Writes a " +
  "markdown file with frontmatter to the appropriate skills directory. " +
  "**Confirm with the user before creating platform- or workspace-scope skills** — they affect " +
  "every conversation in that scope. Manifest fields: `description`, `type` (context|skill), " +
  "`priority` (11–99 for non-core), `loading_strategy` (always|tool_affined), `applies_to_tools` " +
  "(globs; required for `tool_affined`), `status` (defaults active). The body is markdown content. " +
  "Returns the new skill's id (filesystem path).";

const SKILLS_UPDATE_DESCRIPTION =
  "Update an existing skill. Provide the `id` (filesystem path) plus a partial `manifest` patch " +
  "and/or a new `body`. Snapshots the current version to `_versions/` before writing so changes " +
  "are reversible. Bundle (Layer 1) skills are not editable — call returns an error pointing the " +
  "caller at the bundle's own settings surface.";

const SKILLS_DELETE_DESCRIPTION =
  "Delete a Layer 3 skill. Snapshots to `_versions/` before removing the live file. Confirm with " +
  "the user before deleting platform- or workspace-scope skills. Bundle (Layer 1) skills cannot " +
  "be deleted via the platform — those ship with the bundle.";

const SKILLS_ACTIVATE_DESCRIPTION =
  "Activate a skill (set status=active). Sugar over `update`; cleaner permission/audit shape. " +
  "Active skills are eligible for Layer 3 selection on subsequent turns.";

const SKILLS_DEACTIVATE_DESCRIPTION =
  "Deactivate a skill (set status=disabled). The skill stays on disk but is skipped during Layer 3 " +
  "selection. Reactivate with `activate`. Use to mute a skill mid-incident without deleting it.";

const SKILLS_MOVE_SCOPE_DESCRIPTION =
  "Relocate a skill across scope tiers (e.g. workspace → platform to promote a workspace-local " +
  "skill that should apply org-wide). Snapshots the original to `_versions/` in the source scope, " +
  "writes to the target scope, then deletes the source. Permissions: caller must satisfy both " +
  "source and target scope rules.";

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
            enum: ["org", "workspace", "user", "bundle"],
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
            content: textContent(summarizeList(list)),
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
          // Determine scope for the permission check before any FS work.
          // skill:// URIs always resolve to the Layer 1 bundle resource;
          // anything else is path-derived.
          const isUri = id === AUTHORING_GUIDE_URI || id.startsWith(SKILL_URI_PREFIX);
          const scope = isUri ? "bundle" : scopeOfPath(runtime, id);
          if (!scope) {
            return {
              content: textContent(`Skill path "${id}" is not under any allowed root`),
              isError: true,
            };
          }
          const permission = await checkPathAccess(runtime, id, scope, "read");
          if (!permission.allowed) {
            return permissionDenied(permission.reason ?? "Permission denied");
          }
          const result = await readSkillById(runtime, authoringGuidePath, id);
          if (!result) {
            return {
              content: textContent(`Skill not found: ${id}`),
              isError: true,
            };
          }
          return {
            content: textContent(summarizeRead(result)),
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
              content: textContent(`Conversation not found: ${convId}`),
              isError: true,
            };
          }
          return {
            content: textContent(summarizeActive(result)),
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
            content: textContent(summarizeLog(events)),
            structuredContent: { events },
            isError: false,
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "create",
      description: SKILLS_CREATE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["org", "workspace", "user"],
            description: "Tier to write the skill into. Bundle (Layer 1) is not writable.",
          },
          name: {
            type: "string",
            description: "Skill name (alphanumeric, dash, underscore). Becomes the filename.",
          },
          manifest: {
            type: "object",
            description: "Manifest fields. `description`, `type`, `priority` are typical.",
          },
          body: {
            type: "string",
            description: "Markdown body of the skill.",
          },
        },
        required: ["scope", "name"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const result = await createSkill(runtime, input, eventSink);
          return result;
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "update",
      description: SKILLS_UPDATE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filesystem path of the skill to update." },
          manifest: {
            type: "object",
            description:
              "Partial manifest fields to merge. Omitted fields keep their current values.",
          },
          body: {
            type: "string",
            description: "New markdown body. Omit to keep the current body.",
          },
        },
        required: ["id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await updateSkillHandler(runtime, input, eventSink);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "delete",
      description: SKILLS_DELETE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filesystem path of the skill to delete." },
        },
        required: ["id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await deleteSkillHandler(runtime, input, eventSink);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "activate",
      description: SKILLS_ACTIVATE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filesystem path of the skill to activate." },
        },
        required: ["id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await setStatusHandler(runtime, input, "active", eventSink);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "deactivate",
      description: SKILLS_DEACTIVATE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filesystem path of the skill to deactivate." },
        },
        required: ["id"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await setStatusHandler(runtime, input, "disabled", eventSink);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "move_scope",
      description: SKILLS_MOVE_SCOPE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filesystem path of the skill to move." },
          target_scope: {
            type: "string",
            enum: ["org", "workspace", "user"],
            description: "Tier to relocate the skill into.",
          },
        },
        required: ["id", "target_scope"],
      },
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await moveScopeHandler(runtime, input, eventSink);
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
  scope: "org" | "workspace" | "user" | "bundle";
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
  scope: "org" | "workspace" | "user" | "bundle";
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

function skillToListed(skill: Skill): ListedSkill {
  const m = skill.manifest;
  const path = skill.sourcePath || undefined;
  const id = path || `skill-in-memory:${m.name}`;
  return {
    id,
    name: m.name,
    layer: 3,
    scope: m.scope ?? "org",
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
  //
  // Skills surfaced as Layer 1 resources (today: the vendored authoring
  // guide) are filtered out here so they don't appear twice — once via
  // their file path through the contextSkills pool and again as a Layer 1
  // entry below.
  const layer1SourcePaths = new Set<string>([resolve(authoringGuidePath)]);
  if (includeLayer3) {
    const { wsId, userId } = resolveCallContext(runtime);
    const skills = wsId
      ? runtime.loadConversationSkills(wsId, userId)
      : runtime.getContextSkills().concat(runtime.getMatchableSkills());
    for (const skill of skills) {
      if (skill.sourcePath && layer1SourcePaths.has(resolve(skill.sourcePath))) {
        continue;
      }
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
    if (filter.tool_affinity !== undefined) {
      // Short-circuit empty/whitespace-only target: an empty string would
      // match `*`-pattern skills via `toolMatches`, but the operator's
      // intent is clearly "no tool", which should match nothing rather
      // than every wildcard skill.
      const target = filter.tool_affinity.trim();
      if (target.length === 0) return false;
      const patterns = s.appliesToTools ?? [];
      if (patterns.length === 0) return false;
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

/**
 * Defend against symlink escape from inside an allowed root. A writer
 * with access to `{workDir}/workspaces/{wsId}/skills/` could drop a
 * symlink (`evil.md` → `/etc/passwd`); `path.resolve()` normalizes `..`
 * but doesn't resolve symlinks, so the lexical under-root check passes.
 * `realpathSync` chases the link before the second under-root check.
 *
 * Roots are real-pathed too, since the work dir itself may pass through a
 * symlink (e.g. macOS tmpdirs live under `/var/folders/...` which is a
 * symlink into `/private/var/...`).
 *
 * Throws if the realpath escapes; returns the real path on success.
 * Caller has already verified existence (this is the second gate).
 */
function realPathUnderAnyRootOrThrow(target: string, roots: string[]): string {
  const real = realpathSync(target);
  const realRoots = roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  const ok = realRoots.some((root) => real === root || real.startsWith(`${root}/`));
  if (!ok) {
    throw new Error(`Skill path "${target}" resolves through a symlink outside allowed roots`);
  }
  return real;
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

  // Treat as filesystem path. Two security gates:
  //   1. Lexical: the resolved path (.. normalized) sits under an allowed
  //      root. Cheap; rejects most attacks before any FS access.
  //   2. Real: realpath chases symlinks and re-checks under-root. Defends
  //      against symlink escape from inside an allowed dir.
  const roots = allowedReadRoots(runtime, authoringGuidePath);
  if (!isPathUnderAnyRoot(id, roots)) {
    throw new Error(
      `Skill path "${id}" is not under any allowed root (platform/workspace/user/builtin)`,
    );
  }

  if (!existsSync(id)) return null;
  realPathUnderAnyRootOrThrow(id, roots);
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
    scope: "org" | "workspace" | "user" | "bundle";
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

/**
 * Derive a scope label from a filesystem path. Used by `skills__read`
 * when the manifest doesn't carry an explicit scope.
 *
 * Decision matrix mirrors `stampDerivedScope` in runtime.ts so the LIST
 * tool and the READ tool agree on what's mutable. A skill under
 * `{workDir}/skills/` is real platform-tier (writable by org admins);
 * anything outside the three workDir roots is bundle-tier (vendored
 * with the platform binary or an MCP bundle, and read-only).
 */
function inferScopeFromPath(
  path: string,
  workDir: string,
): "org" | "workspace" | "user" | "bundle" {
  const resolved = resolve(path);
  if (resolved.startsWith(`${resolve(workDir, "workspaces")}/`)) return "workspace";
  if (resolved.startsWith(`${resolve(workDir, "users")}/`)) return "user";
  if (resolved.startsWith(`${resolve(workDir, "skills")}/`)) return "org";
  return "bundle";
}

interface ActiveForEntry {
  id: string;
  layer: 3;
  scope: "org" | "workspace" | "user" | "bundle";
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
        scope: (s.scope ?? "org") as ActiveForEntry["scope"],
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
  // event-sourced store is the only one with `readEvents`. Returns null
  // when the store is missing (no workspace context) or is some other
  // shape (e.g. an in-memory test double).
  try {
    const raw = runtime.getConversationStore();
    return raw instanceof EventSourcedConversationStore ? raw : null;
  } catch {
    return null;
  }
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
    content: textContent(message),
    isError: true,
  };
}

// ── Human-readable summaries for tool `content` field ──────────────────
//
// Per AGENTS.md, `content` carries a short human-readable summary; the
// full structured payload lives only in `structuredContent`. Each summary
// is one or two short lines optimized for a debug log or a CLI render —
// agents and UI clients consume the structured form.

function summarizeList(skills: ListedSkill[]): string {
  if (skills.length === 0) return "0 skills";
  const byScope = new Map<string, number>();
  for (const s of skills) byScope.set(s.scope, (byScope.get(s.scope) ?? 0) + 1);
  const breakdown = Array.from(byScope.entries())
    .sort()
    .map(([scope, count]) => `${count} ${scope}`)
    .join(", ");
  return `${skills.length} skill${skills.length === 1 ? "" : "s"} (${breakdown})`;
}

function summarizeRead(skill: ReadResult): string {
  const m = skill.metadata;
  const parts = [`${m.name} (L${skill.layer} ${skill.scope})`];
  if (m.loadingStrategy) parts.push(`loads: ${m.loadingStrategy}`);
  if (m.status && m.status !== "active") parts.push(`status: ${m.status}`);
  return parts.join(" · ");
}

function summarizeActive(active: ActiveForEntry[]): string {
  if (active.length === 0) return "No skills loaded for this conversation yet.";
  const totalTokens = active.reduce((sum, a) => sum + a.tokens, 0);
  return `${active.length} skill${active.length === 1 ? "" : "s"} loaded · ${totalTokens} tokens`;
}

function summarizeLog(events: LoadingLogEntry[]): string {
  if (events.length === 0) return "No skills.loaded events match the filters.";
  const conversations = new Set(events.map((e) => e.conv_id)).size;
  return `${events.length} run${events.length === 1 ? "" : "s"} across ${conversations} conversation${conversations === 1 ? "" : "s"}`;
}

// ── Mutation handlers ────────────────────────────────────────────────────

type WritableScope = "org" | "workspace" | "user";
const WRITABLE_SCOPES = new Set<WritableScope>(["org", "workspace", "user"]);

interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

const ORG_ADMIN_ROLES = new Set(["admin", "owner"]);

type AccessMode = "read" | "write";

/**
 * Path-derived permission gate. The workspace and user identifiers come
 * from the on-disk path being mutated (or read), NOT from the request
 * context, so a workspace admin in `wsA` can't mutate / read a skill at
 * `{workDir}/workspaces/wsB/skills/...` by naming the path directly.
 *
 * Strict cross-tenant policy: workspace skills require explicit
 * membership in the workspace named by the path (no silent org-admin
 * override into untouched workspaces — operators must switch to the
 * workspace explicitly). User skills require the caller's identity id
 * to match the user-segment in the path.
 *
 * Tier rules (read | write):
 *   - bundle      — read: anyone (Layer 1 vendored). write: refused (caller side).
 *   - platform    — read: any tenant member.            write: org admin/owner.
 *   - workspace   — read+write: must be a member of the path's workspace.
 *                   write also requires `admin` role in that workspace.
 *   - user        — read+write: only the owning user.
 *
 * Dev mode (no identity provider) opens everything, matching the
 * `instructions.ts` precedent.
 *
 * For "create" operations the path doesn't exist yet — pass the
 * destination directory as `path` (e.g. `{workDir}/workspaces/{wsId}/skills`).
 * The wsId/userId derivation works on directory paths the same way.
 */
async function checkPathAccess(
  runtime: Runtime,
  path: string,
  scope: WritableScope | "bundle",
  mode: AccessMode,
): Promise<PermissionDecision> {
  if (runtime.getIdentityProvider() === null) return { allowed: true };
  const identity = runtime.getCurrentIdentity();
  if (!identity) return { allowed: false, reason: "No authenticated identity" };

  const isOrgAdmin = ORG_ADMIN_ROLES.has(identity.orgRole);
  const workDir = runtime.getWorkDir();

  if (scope === "bundle") {
    if (mode === "read") return { allowed: true };
    return { allowed: false, reason: "Bundle (Layer 1) skills are vendored and not mutable" };
  }

  if (scope === "org") {
    if (mode === "read") return { allowed: true };
    return isOrgAdmin
      ? { allowed: true }
      : { allowed: false, reason: "Org-scope writes require org admin or owner" };
  }

  if (scope === "user") {
    const pathUserId = extractUserIdFromPath(path, workDir);
    if (!pathUserId) {
      return { allowed: false, reason: "Could not derive user id from path" };
    }
    if (pathUserId === identity.id) return { allowed: true };
    // Strict — no org-admin override across users. Operators access
    // their own user-tier skills only.
    return {
      allowed: false,
      reason: `User-scope skills are scoped to their owning user (${pathUserId})`,
    };
  }

  // workspace
  const pathWsId = extractWsIdFromPath(path, workDir);
  if (!pathWsId) {
    return { allowed: false, reason: "Could not derive workspace id from path" };
  }
  const ws = await runtime.getWorkspaceStore().get(pathWsId);
  if (!ws) return { allowed: false, reason: `Workspace "${pathWsId}" not found` };
  const member = ws.members.find((m) => m.userId === identity.id);
  if (!member) {
    // Strict — no org-admin override into a workspace the operator
    // isn't a member of. Switch workspaces explicitly to act on its
    // skills.
    return {
      allowed: false,
      reason: `Not a member of workspace "${pathWsId}"`,
    };
  }
  if (mode === "write" && member.role !== "admin") {
    return {
      allowed: false,
      reason: `Workspace-scope writes require admin role in workspace "${pathWsId}"`,
    };
  }
  return { allowed: true };
}

/**
 * Resolve the on-disk directory for a writable scope. Mirrors the layout
 * the loader scans (`{workDir}/skills`, `{workDir}/workspaces/{wsId}/skills`,
 * `{workDir}/users/{userId}/skills`). Throws when context is missing for
 * the requested scope so the caller can surface a clear error.
 */
function scopeDir(runtime: Runtime, scope: WritableScope): string {
  const workDir = runtime.getWorkDir();
  if (scope === "org") return join(workDir, "skills");
  if (scope === "workspace") {
    const wsId = runtime.requireWorkspaceId();
    return join(workDir, "workspaces", wsId, "skills");
  }
  // user
  const identity = runtime.getCurrentIdentity();
  const userId = identity?.id;
  if (!userId) throw new Error("User-scope writes require an authenticated identity");
  return join(workDir, "users", userId, "skills");
}

/**
 * Reject identifiers that don't fit the loader's filename rules. Belt-
 * and-braces against tools whose JSON-schema gate is bypassed (e.g.
 * external MCP clients that don't validate enums).
 */
const VALID_NAME_RE = /^[a-zA-Z0-9_-]+$/;
function assertValidName(name: string): void {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name "${name}" — letters, digits, dash, underscore only`);
  }
}

function scopeOfPath(runtime: Runtime, path: string): WritableScope | "bundle" | null {
  const work = resolve(runtime.getWorkDir());
  const real = resolve(path);
  if (real.startsWith(`${join(work, "workspaces")}/`)) return "workspace";
  if (real.startsWith(`${join(work, "users")}/`)) return "user";
  if (real.startsWith(`${join(work, "skills")}/`)) return "org";
  // Anything else — typically bundled built-ins under src/skills/builtin —
  // is treated as bundle-tier and not mutable.
  return "bundle";
}

/**
 * Write the existing live file (if any) to `{dir}/_versions/{name}.{iso}.md`
 * before a destructive operation. The loader's `_versions/` skip means
 * snapshots never accidentally re-load as live skills.
 */
function snapshotVersion(filePath: string): void {
  if (!existsSync(filePath)) return;
  const dir = dirname(filePath);
  const base = filePath.split("/").pop() ?? "skill.md";
  const name = base.replace(/\.md$/, "");
  const versionsDir = join(dir, "_versions");
  mkdirSync(versionsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(filePath, join(versionsDir, `${name}.${stamp}.md`));
}

function permissionDenied(reason: string): ToolResult {
  return {
    content: textContent(reason),
    structuredContent: { error: reason, code: "permission_denied" },
    isError: true,
  };
}

function bundleNotMutable(): ToolResult {
  return {
    content: textContent(
      "Bundle (Layer 1) skills are vendored — edit them through the bundle's own settings surface, not the platform.",
    ),
    structuredContent: { error: "skill_not_mutable_via_platform", layer: 1 },
    isError: true,
  };
}

interface CreateInput {
  scope?: string;
  name?: string;
  manifest?: Record<string, unknown>;
  body?: string;
}

async function createSkill(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
): Promise<ToolResult> {
  const { scope, name, manifest: rawManifest, body } = input as CreateInput;
  if (!scope || !WRITABLE_SCOPES.has(scope as WritableScope)) {
    return errorResult(
      new Error(`Scope must be one of platform | workspace | user (got "${scope}")`),
    );
  }
  if (!name) return errorResult(new Error("`name` is required"));
  assertValidName(name);

  const writableScope = scope as WritableScope;
  // Resolve the target dir first so the permission check uses the
  // *destination* path. For workspace/user creates this binds the wsId
  // / userId to the current request context (you can only create inside
  // your own workspace / user dir), and the path-derived membership
  // check still applies.
  let dir: string;
  try {
    dir = scopeDir(runtime, writableScope);
  } catch (err) {
    return errorResult(err);
  }
  const target = join(dir, `${name}.md`);
  const permission = await checkPathAccess(runtime, target, writableScope, "write");
  if (!permission.allowed) return permissionDenied(permission.reason ?? "Permission denied");

  if (existsSync(target)) {
    return errorResult(new Error(`Skill "${name}" already exists in ${writableScope} scope`));
  }

  const merged = coerceManifestInput(name, rawManifest);
  const validation = validateSkill(name, merged, body ?? "");
  if (!validation.valid) {
    return errorResult(new Error(`Validation failed — ${validation.errors.join("; ")}`));
  }

  writeSkill(dir, name, merged, body ?? "");
  eventSink.emit({
    type: "skill.created",
    data: { id: target, name, scope: writableScope, type: merged.type },
  });
  return {
    content: textContent(`Created ${writableScope} skill "${name}" → ${target}`),
    structuredContent: { id: target, name, scope: writableScope },
    isError: false,
  };
}

async function updateSkillHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
): Promise<ToolResult> {
  const {
    id,
    manifest: patchRaw,
    body,
  } = input as {
    id?: string;
    manifest?: Record<string, unknown>;
    body?: string;
  };
  if (!id) return errorResult(new Error("`id` is required"));

  const scope = scopeOfPath(runtime, id);
  if (scope === "bundle") return bundleNotMutable();
  if (!scope) return errorResult(new Error(`Skill path "${id}" is not under any allowed root`));

  const permission = await checkPathAccess(runtime, id, scope, "write");
  if (!permission.allowed) return permissionDenied(permission.reason ?? "Permission denied");

  if (!existsSync(id)) return errorResult(new Error(`Skill not found: ${id}`));

  // Defense-in-depth: chase symlinks and confirm the realpath sits under
  // the same allowed root before any FS write. snapshotVersion uses
  // copyFileSync, which follows symlinks at the source — without this
  // guard a workspace member could `ln -s /etc/passwd evil.md` and have
  // the platform copy its contents into _versions/, then re-read it via
  // skills__read.
  try {
    realPathUnderAnyRootOrThrow(id, allowedReadRoots(runtime, ""));
  } catch (err) {
    return errorResult(err);
  }

  const dir = dirname(id);
  const name = (id.split("/").pop() ?? "").replace(/\.md$/, "");
  if (!name) return errorResult(new Error(`Cannot derive skill name from path "${id}"`));

  snapshotVersion(id);

  // Reuse the writer's merge logic so behavior matches `system_tools` edit.
  const partial = patchRaw ? coerceManifestPatch(patchRaw) : undefined;
  updateSkill(dir, name, partial, body);

  eventSink.emit({ type: "skill.updated", data: { id, name, scope } });
  return {
    content: textContent(`Updated ${scope} skill "${name}"`),
    structuredContent: { id, name, scope },
    isError: false,
  };
}

async function deleteSkillHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
): Promise<ToolResult> {
  const { id } = input as { id?: string };
  if (!id) return errorResult(new Error("`id` is required"));

  const scope = scopeOfPath(runtime, id);
  if (scope === "bundle") return bundleNotMutable();
  if (!scope) return errorResult(new Error(`Skill path "${id}" is not under any allowed root`));

  const permission = await checkPathAccess(runtime, id, scope, "write");
  if (!permission.allowed) return permissionDenied(permission.reason ?? "Permission denied");

  if (!existsSync(id)) return errorResult(new Error(`Skill not found: ${id}`));

  // Symlink-escape defense — see updateSkillHandler for rationale.
  try {
    realPathUnderAnyRootOrThrow(id, allowedReadRoots(runtime, ""));
  } catch (err) {
    return errorResult(err);
  }

  const dir = dirname(id);
  const name = (id.split("/").pop() ?? "").replace(/\.md$/, "");
  if (!name) return errorResult(new Error(`Cannot derive skill name from path "${id}"`));

  snapshotVersion(id);
  deleteSkill(dir, name);

  eventSink.emit({ type: "skill.deleted", data: { id, name, scope } });
  return {
    content: textContent(`Deleted ${scope} skill "${name}" (snapshotted to _versions/)`),
    structuredContent: { id, name, scope },
    isError: false,
  };
}

async function setStatusHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  status: "active" | "disabled",
  eventSink: EventSink,
): Promise<ToolResult> {
  return updateSkillHandler(runtime, { id: input.id, manifest: { status } }, eventSink);
}

async function moveScopeHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
): Promise<ToolResult> {
  const { id, target_scope } = input as { id?: string; target_scope?: string };
  if (!id) return errorResult(new Error("`id` is required"));
  if (!target_scope || !WRITABLE_SCOPES.has(target_scope as WritableScope)) {
    return errorResult(
      new Error(`target_scope must be one of platform | workspace | user (got "${target_scope}")`),
    );
  }
  const sourceScope = scopeOfPath(runtime, id);
  if (sourceScope === "bundle") return bundleNotMutable();
  if (!sourceScope) {
    return errorResult(new Error(`Skill path "${id}" is not under any allowed root`));
  }
  const target = target_scope as WritableScope;
  if (sourceScope === target) {
    return errorResult(new Error(`Skill is already in ${target} scope`));
  }

  // Source permission — derived from the *source path's* workspace/user
  // segment. A workspace admin in wsA cannot move a skill out of wsB.
  const sourceCheck = await checkPathAccess(runtime, id, sourceScope, "write");
  if (!sourceCheck.allowed) return permissionDenied(sourceCheck.reason ?? "Permission denied");

  // Target permission — derived from the destination path. For
  // workspace/user targets, scopeDir() picks the caller's own
  // workspace/user dir, so this is naturally bound to the caller's
  // identity (no cross-tenant promotion possible).
  let targetDir: string;
  try {
    targetDir = scopeDir(runtime, target);
  } catch (err) {
    return errorResult(err);
  }
  const targetCheck = await checkPathAccess(runtime, targetDir, target, "write");
  if (!targetCheck.allowed) return permissionDenied(targetCheck.reason ?? "Permission denied");

  if (!existsSync(id)) return errorResult(new Error(`Skill not found: ${id}`));

  // Symlink-escape defense on the source path before reading + copying.
  try {
    realPathUnderAnyRootOrThrow(id, allowedReadRoots(runtime, ""));
  } catch (err) {
    return errorResult(err);
  }

  const skill = parseSkillFile(id);
  if (!skill) return errorResult(new Error(`Failed to parse skill at ${id}`));
  const name = skill.manifest.name;
  const targetPath = join(targetDir, `${name}.md`);
  if (existsSync(targetPath)) {
    return errorResult(new Error(`A skill named "${name}" already exists in ${target} scope`));
  }

  snapshotVersion(id);
  // Strip the source scope from the manifest so the target dir's loader
  // stamp wins without conflicting with a stale frontmatter value.
  const { scope: _drop, ...manifestWithoutScope } = skill.manifest;
  writeSkill(targetDir, name, manifestWithoutScope as typeof skill.manifest, skill.body);
  deleteSkill(dirname(id), name);

  eventSink.emit({
    type: "skill.updated",
    data: { id: targetPath, name, scope: target, action: "move_scope", from: sourceScope },
  });
  return {
    content: textContent(`Moved skill "${name}" from ${sourceScope} → ${target}`),
    structuredContent: { id: targetPath, name, scope: target, fromScope: sourceScope },
    isError: false,
  };
}

function extractUserIdFromPath(path: string, workDir: string): string | null {
  const real = resolve(path);
  const usersDir = `${resolve(workDir, "users")}/`;
  if (!real.startsWith(usersDir)) return null;
  const tail = real.slice(usersDir.length);
  const slash = tail.indexOf("/");
  return slash > 0 ? tail.slice(0, slash) : null;
}

function extractWsIdFromPath(path: string, workDir: string): string | null {
  const real = resolve(path);
  const wsRoot = `${resolve(workDir, "workspaces")}/`;
  if (!real.startsWith(wsRoot)) return null;
  const tail = real.slice(wsRoot.length);
  const slash = tail.indexOf("/");
  return slash > 0 ? tail.slice(0, slash) : null;
}
