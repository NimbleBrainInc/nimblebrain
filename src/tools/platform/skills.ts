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
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { parseSkillFile, readSkillMtime } from "../../skills/loader.ts";
import { toolMatches } from "../../skills/select.ts";
import { approxTokens } from "../../skills/tokens.ts";
import type { Skill, SkillManifest } from "../../skills/types.ts";
import { validateSkill } from "../../skills/validator.ts";
import { deleteSkill, updateSkill, writeSkill } from "../../skills/writer.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import {
  SkillsActivateInput,
  SkillsActiveForInput,
  SkillsCreateInput,
  SkillsDeactivateInput,
  SkillsDeleteInput,
  SkillsListInput,
  SkillsLoadingLogInput,
  SkillsMoveScopeInput,
  SkillsReadInput,
  SkillsUpdateInput,
} from "./schemas/skills.ts";

// ── Source name ──────────────────────────────────────────────────────────

/** Source name — keep stable; tools surface as `skills__list`, etc. */
export const SKILLS_SOURCE_NAME = "skills";

// ── Constants ────────────────────────────────────────────────────────────

const SKILL_URI_PREFIX = "skill://";
const AUTHORING_GUIDE_URI = "skill://skills/authoring-guide";

// ── Tool descriptions (description-as-policy) ────────────────────────────

const SKILLS_LIST_DESCRIPTION =
  "List Layer 3 skills (cross-bundle agent orchestration content) and Layer 1 vendored bundle skills. " +
  "Filter by `scope` (org | workspace | user | bundle), `layer` (1 | 3), `type` (context | skill), " +
  "`tool_affinity` (a tool name; returns skills whose `applies_to_tools` glob matches it), " +
  "`status` (active | draft | disabled | archived), or `modified_since` (ISO 8601). " +
  "Returns id, name, layer, scope, status, token count, and source metadata for each skill. " +
  "Use this to answer 'what skills do I have?' or 'what's available for the active tool set?'";

const SKILLS_READ_DESCRIPTION =
  "Read one skill by id. The `id` is either a filesystem path (returned by `skills__list`) " +
  "or a bundle skill:// URI. Returns the markdown body plus parsed manifest fields (name, " +
  "description, version, type, priority, scope, layer, loading_strategy, applies_to_tools, " +
  "status, allowed_tools, requires_bundles, metadata). Always call `skills__list` first to " +
  "discover ids — bare names and scope-prefixed forms (e.g. `org/foo`) are NOT valid input.";

const SKILLS_ACTIVE_FOR_DESCRIPTION =
  "Show which Layer 3 skills are currently loaded for a conversation. " +
  "`conversation_id` is optional inside a chat — when omitted, defaults to the " +
  "current conversation (the one this tool call belongs to). Returns one entry per " +
  "loaded skill with id, layer, scope, token count, `loadedBy` (`always` or " +
  "`tool_affinity`), and a human-readable `reason`. Use this to answer 'what's " +
  "active for this conversation right now?' — distinct from `skills__list` which " +
  "enumerates the catalog regardless of load state.";

const SKILLS_LOADING_LOG_DESCRIPTION =
  "Replay `skills.loaded` events from conversation logs. Filter by `conversation_id`, `skill_id`, " +
  "and a `since`/`until` ISO 8601 window. Returns one entry per run with timestamp, conversation id, " +
  "run id, the skills loaded for that run, total tokens, and the active tool set at the time. " +
  "Use to audit which skills fired across a window of activity, or to debug why a particular skill " +
  "did or did not load.";

const SKILLS_CREATE_DESCRIPTION =
  "Create a Layer 3 skill at the given scope (`org`, `workspace`, or `user`). Writes a " +
  "markdown file with YAML frontmatter — `manifest` becomes the frontmatter, `body` is the " +
  "markdown below it. **Confirm with the user before creating org- or workspace-scope " +
  "skills** — they affect every conversation in that scope. Returns the new skill's id " +
  "(filesystem path).";

const SKILLS_UPDATE_DESCRIPTION =
  "Update an existing Layer 3 skill. The `id` is the filesystem path returned by `skills__list` " +
  "(call that first — bare names and scope-prefixed forms are NOT valid). Provide a partial " +
  "`manifest` patch (any subset of the create-shape fields) and/or a new `body`. Snapshots the " +
  "current version to `_versions/` before writing. Bundle (Layer 1) skills are not editable.";

// Tool input schemas live in `./schemas/skills.ts` — see the catalog at
// `./schemas/catalog.ts`. Operator/advanced fields (`allowedTools`,
// `requiresBundles`, `loadingStrategy`, `appliesToTools`, `overrides`,
// `derivedFrom`) are intentionally absent from the LLM-facing schema (see
// SCHEMA_PRINCIPLES at the bottom of this file). They live on the type
// and the on-disk format; if a future change makes them load-bearing for
// agent authoring, add them to the schemas/skills.ts module deliberately
// with a description.

const SKILLS_DELETE_DESCRIPTION =
  "Delete a Layer 3 skill. The `id` is the filesystem path returned by `skills__list`. " +
  "Snapshots to `_versions/` before removing the live file. Confirm with the user before " +
  "deleting org- or workspace-scope skills. Bundle (Layer 1) skills cannot be deleted via " +
  "the platform — those ship with the bundle.";

const SKILLS_ACTIVATE_DESCRIPTION =
  "Activate a skill (set status=active). Sugar over `update`; cleaner permission/audit shape. " +
  "Active skills are eligible for Layer 3 selection on subsequent turns.";

const SKILLS_DEACTIVATE_DESCRIPTION =
  "Deactivate a skill (set status=disabled). The skill stays on disk but is skipped during Layer 3 " +
  "selection. Reactivate with `activate`. Use to mute a skill mid-incident without deleting it.";

const SKILLS_MOVE_SCOPE_DESCRIPTION =
  "Relocate a Layer 3 skill across scope tiers (e.g. workspace → org to promote a " +
  "workspace-local skill that should apply org-wide). The `id` is the filesystem path returned " +
  "by `skills__list`. Snapshots the original to `_versions/` in the source scope, writes to " +
  "the target scope, then deletes the source. Permissions: caller must satisfy both source " +
  "and target scope rules.";

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
      inputSchema: SkillsListInput,
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
      inputSchema: SkillsReadInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const id = String(input.id ?? "");
          // Determine scope for the permission check before any FS work.
          // skill:// URIs always resolve to the Layer 1 bundle resource;
          // anything else is path-derived.
          const isUri = id === AUTHORING_GUIDE_URI || id.startsWith(SKILL_URI_PREFIX);
          const scope = isUri ? "bundle" : scopeOfPath(runtime, id, authoringGuidePath);
          if (!scope) {
            return {
              content: textContent(unrecognizedIdMessage(id)),
              isError: true,
            };
          }
          // Existence before permission. A stale `id` (e.g. a path the
          // agent cached before the skill was moved to a workspace dir)
          // should report "not found" — telling the caller their file
          // is gone. Reporting "permission denied" on a missing path
          // sends the agent down a hallucination loop trying to fix a
          // role instead of refreshing its path. (skill:// URIs skip
          // this — existence is checked inside readSkillById.)
          //
          // Trade-off: an authenticated tenant member can now distinguish
          // "file exists but I lack permission" from "file doesn't exist"
          // for paths in other workspaces — a thin filename-existence
          // oracle. Severity is low in our threat model: skill filenames
          // are not secrets, content is still gated by checkPathAccess,
          // and the caller is already inside the tenant. If a future
          // deployment needs to close this oracle, gate the existence
          // check behind the same scope-allowance that `checkPathAccess`
          // applies (e.g. only run existsSync for paths in the caller's
          // own workspace / user dir / org).
          if (!isUri && !existsSync(id)) {
            return {
              content: textContent(
                `Skill not found at "${id}". The file may have been moved or deleted — ` +
                  `call skills__list to get current paths.`,
              ),
              isError: true,
            };
          }
          const permission = await checkPathAccess(runtime, id, scope, "read");
          if (!permission.allowed) {
            return permissionDenied(permission.reason ?? "Permission denied", {
              path: id,
              scope,
              role: currentRoleHint(runtime, scope),
            });
          }
          // Symlink-boundary check (skipped for skill:// URIs which
          // dispatch to the resource handler, not the filesystem path).
          // Without this, a tenant member could symlink another
          // workspace's skill into their own dir and read its
          // contents via parseSkillFile (which follows symlinks).
          if (!isUri) {
            try {
              assertSymlinkBoundaryOrThrow(runtime, id, scope);
            } catch (err) {
              return errorResult(err);
            }
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
      inputSchema: SkillsActiveForInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          // Explicit arg wins; otherwise use the current conversation from
          // request context. The agent making this call from inside a chat
          // doesn't know its own conv id, so requiring it forced agents to
          // either guess or skip the tool entirely.
          const argConvId =
            typeof input.conversation_id === "string" && input.conversation_id.length > 0
              ? input.conversation_id
              : undefined;
          const ctxConvId = getRequestContext()?.conversationId;
          const convId = argConvId ?? ctxConvId;
          if (!convId) {
            return {
              content: textContent(
                "conversation_id is required when called outside a chat — " +
                  "no current conversation is in scope. Pass conversation_id explicitly.",
              ),
              isError: true,
            };
          }
          const result = await activeForConversation(runtime, convId);
          if (result === null) {
            return {
              content: textContent(`Conversation not found: ${convId}`),
              isError: true,
            };
          }
          return {
            content: textContent(summarizeActive(result)),
            structuredContent: { active: result, conversationId: convId },
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
      inputSchema: SkillsLoadingLogInput,
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
      inputSchema: SkillsCreateInput,
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
      inputSchema: SkillsUpdateInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await updateSkillHandler(runtime, input, eventSink, authoringGuidePath);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "delete",
      description: SKILLS_DELETE_DESCRIPTION,
      inputSchema: SkillsDeleteInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await deleteSkillHandler(runtime, input, eventSink, authoringGuidePath);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "activate",
      description: SKILLS_ACTIVATE_DESCRIPTION,
      inputSchema: SkillsActivateInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await setStatusHandler(runtime, input, "active", eventSink, authoringGuidePath);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "deactivate",
      description: SKILLS_DEACTIVATE_DESCRIPTION,
      inputSchema: SkillsDeactivateInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await setStatusHandler(runtime, input, "disabled", eventSink, authoringGuidePath);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "move_scope",
      description: SKILLS_MOVE_SCOPE_DESCRIPTION,
      inputSchema: SkillsMoveScopeInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await moveScopeHandler(runtime, input, eventSink, authoringGuidePath);
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
  return [
    join(workDir, "skills"),
    join(workDir, "workspaces"),
    join(workDir, "users"),
    ...bundleSkillRoots(authoringGuidePath),
  ].map((r) => resolve(r));
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

/**
 * Boundary check that catches symlink-based tenant escape.
 *
 * `realPathUnderAnyRootOrThrow` only verifies the realpath sits under
 * SOME allowed root. That's insufficient when the link target is itself
 * inside the platform's roots — e.g. a symlink at
 * `{workDir}/workspaces/wsA/skills/evil.md` pointing to
 * `{workDir}/workspaces/wsB/skills/secret.md` passes the under-root
 * check, but `snapshotVersion`'s `copyFileSync` (and `readSkillById`'s
 * `parseSkillFile`) then follow the link and read wsB's content from a
 * caller authorised only for wsA.
 *
 * This helper additionally requires the realpath's scope and tenant
 * identifier to match the lexical declaration:
 *
 *   1. realScope === expectedScope — catches tier-jumping (workspace
 *      symlink → user file, etc.) AND outside-workdir paths (the local
 *      fallback below classifies those as `"bundle"`, which never
 *      matches an `expectedScope` of `workspace` / `user` / `org`).
 *   2. realWsId === lexicalWsId for workspace scope — catches
 *      cross-workspace symlinks within `{workDir}/workspaces/`.
 *   3. realUserId === lexicalUserId for user scope — same for
 *      `{workDir}/users/`.
 *
 * Called from update / delete / move_scope (after existsSync, before
 * any FS read or write that follows symlinks) and from skills__read.
 */
function assertSymlinkBoundaryOrThrow(
  runtime: Runtime,
  target: string,
  expectedScope: WritableScope | "bundle",
): void {
  const real = realpathSync(target);
  const workDir = runtime.getWorkDir();
  // realpath the workDir too so macOS tmpdir paths
  // (`/var/folders/...` → `/private/var/folders/...`) don't make every
  // legit comparison fail. Both sides need the same "real" base.
  let realWorkDir = workDir;
  try {
    realWorkDir = realpathSync(workDir);
  } catch {
    /* fall back to lexical workDir */
  }

  // Compute realScope from the realpath against the realpath'd workDir.
  const wsRoot = `${join(realWorkDir, "workspaces")}/`;
  const userRoot = `${join(realWorkDir, "users")}/`;
  const orgRoot = `${join(realWorkDir, "skills")}/`;
  let realScope: WritableScope | "bundle";
  if (real.startsWith(wsRoot)) realScope = "workspace";
  else if (real.startsWith(userRoot)) realScope = "user";
  else if (real.startsWith(orgRoot)) realScope = "org";
  else realScope = "bundle";

  if (realScope !== expectedScope) {
    throw new Error(
      `Skill path "${target}" resolves through a symlink to a different scope ` +
        `(declared ${expectedScope}, real ${realScope})`,
    );
  }

  if (expectedScope === "workspace") {
    const lexWs = extractWsIdFromPath(target, workDir);
    const realWs = extractWsIdFromPath(real, realWorkDir);
    if (lexWs !== realWs) {
      throw new Error(
        `Skill path "${target}" resolves through a symlink to a different workspace ` +
          `(declared "${lexWs}", real "${realWs}")`,
      );
    }
  }
  if (expectedScope === "user") {
    const lexUser = extractUserIdFromPath(target, workDir);
    const realUser = extractUserIdFromPath(real, realWorkDir);
    if (lexUser !== realUser) {
      throw new Error(
        `Skill path "${target}" resolves through a symlink to a different user ` +
          `(declared "${lexUser}", real "${realUser}")`,
      );
    }
  }
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
    throw new Error(unrecognizedIdMessage(id));
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
 * Read raw conversation events for the given id from the top-level
 * conversation store. Returns `null` for not-found, `[]` for legacy
 * (message-format) conversations.
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
  // The runtime exposes a `ConversationStore` interface; only the
  // event-sourced store has `readEvents`. Returns null when the store
  // is some other shape (e.g. an in-memory test double).
  try {
    const raw = runtime.findConversationStore();
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
  const header = `${skills.length} skill${skills.length === 1 ? "" : "s"} (${breakdown})`;
  // Emit one row per skill so an LLM consumer can read IDs without
  // depending on structuredContent (which the engine doesn't surface to
  // the model). Rows are stable & terse: id, scope/layer/type/priority
  // tags, status if not active, and a truncated description.
  const lines = skills.map((s) => {
    const tags: string[] = [`L${s.layer}`, s.scope];
    if (s.type) tags.push(s.type);
    if (s.priority != null) tags.push(`p${s.priority}`);
    if (s.status && s.status !== "active") tags.push(s.status);
    const meta = `(${tags.join(" ")})`;
    const desc = s.description ? ` — ${s.description.slice(0, 100)}` : "";
    return `- ${s.id} ${meta}${desc}`;
  });
  return `${header}\n${lines.join("\n")}`;
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
 *   - org         — read: any tenant member.            write: org admin/owner.
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
    return runtime.getWorkspaceContext(wsId).getDataPath("skills");
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

/**
 * The two filesystem roots that hold bundle-vendored skills (Layer 1):
 * the authoring guide's own directory (`src/skills/builtin`) and the
 * sibling core dir (`src/skills/core`). Computed from `authoringGuidePath`
 * so adding/moving bundle skill roots happens in one place.
 */
function bundleSkillRoots(authoringGuidePath: string): string[] {
  return [resolve(authoringGuidePath, ".."), resolve(authoringGuidePath, "../../core")];
}

/**
 * Classify a filesystem path into a writable scope (`workspace` / `user` /
 * `org`), the read-only `bundle` tier, or `null` if the path doesn't sit
 * under any known skill root.
 *
 * Returning `null` for unclassified paths (rather than the previous "treat
 * as bundle" fallback) is load-bearing: callers — especially mutation
 * handlers — distinguish "this is a real bundle skill" from "this id is
 * garbage / bare name / wrong shape." The previous behavior turned every
 * mistyped path into a misleading "Bundle (Layer 1) skills are vendored"
 * error.
 */
function scopeOfPath(
  runtime: Runtime,
  path: string,
  authoringGuidePath: string,
): WritableScope | "bundle" | null {
  const work = resolve(runtime.getWorkDir());
  const real = resolve(path);
  if (real.startsWith(`${join(work, "workspaces")}/`)) return "workspace";
  if (real.startsWith(`${join(work, "users")}/`)) return "user";
  if (real.startsWith(`${join(work, "skills")}/`)) return "org";
  for (const root of bundleSkillRoots(authoringGuidePath)) {
    if (real === root || real.startsWith(`${root}/`)) return "bundle";
  }
  return null;
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

/**
 * Trigger a runtime reload of the boot-time skill pool after a mutation.
 *
 * `loadConversationSkills` reads workspace + user + org dirs fresh per
 * call, but the `SkillMatcher` (which scans triggers/keywords on
 * `runtime.chat()` to set `skillName`) is built only at boot and on
 * explicit `reloadSkills()`. Without this call, a freshly-created
 * org-tier skill won't match its triggers until the process restarts.
 *
 * Errors are swallowed: the on-disk write already succeeded, the file
 * will load on next boot, and the operator already has a successful
 * mutation result. Logging the failure beats failing the whole call.
 */
async function reloadBootSkills(runtime: Runtime): Promise<void> {
  try {
    await runtime.reloadSkills();
  } catch (err) {
    console.error("[skills] reloadSkills failed after mutation:", err);
  }
}

/**
 * Render a permission-denied error with causation. The bare reason from
 * `checkPathAccess` ("Org-scope writes require org admin or owner") leaves
 * the caller hypothesizing about why their path landed in that scope and
 * what role they actually have — surfaced as a real problem in production
 * when an agent looped trying to fix its role instead of fixing its `id`.
 *
 * Now appends:
 *   - which scope was inferred and that it came from the path prefix
 *   - the caller's current role (when known)
 *   - what an alternate-scope path would look like
 *
 * Self-correctable signal for both LLM agents and human operators.
 */
function permissionDenied(
  reason: string,
  context?: {
    path?: string;
    scope?: WritableScope | "bundle";
    role?: string;
  },
): ToolResult {
  const lines: string[] = [reason];
  if (context?.path && context.scope) {
    lines.push(
      `Path "${context.path}" classified as ${context.scope}-scope (derived from path prefix).`,
    );
    if (context.scope === "org") {
      lines.push(
        "If this skill should be workspace-scoped, the path would be " +
          "/data/workspaces/<wsId>/skills/<file>. Run skills__list to refresh paths.",
      );
    } else if (context.scope === "workspace") {
      lines.push(
        "If this skill should be user-scoped, the path would be " +
          "/data/users/<userId>/skills/<file>. Run skills__list to refresh paths.",
      );
    }
  }
  if (context?.role) {
    lines.push(`Your current role: ${context.role}.`);
  }
  return {
    content: textContent(lines.join("\n")),
    structuredContent: {
      error: reason,
      code: "permission_denied",
      ...(context?.path ? { path: context.path } : {}),
      ...(context?.scope ? { scope: context.scope } : {}),
      ...(context?.role ? { role: context.role } : {}),
    },
    isError: true,
  };
}

/** Best-effort role lookup for permission-denied causation messages. */
function currentRoleHint(runtime: Runtime, scope: WritableScope | "bundle"): string | undefined {
  const identity = runtime.getCurrentIdentity();
  if (!identity) return undefined;
  if (scope === "workspace") {
    // Workspace role lives on the membership record, not the identity —
    // resolving it here would require the path's wsId and an async store
    // read. The org role is informative enough for the message.
    return `org=${identity.orgRole}`;
  }
  return identity.orgRole;
}

function bundleNotMutable(): ToolResult {
  // Structured error shape per the skill management design doc — the
  // `suggested_action` discriminator lets calling agents present the
  // right next step without parsing prose.
  //
  // TODO: the design doc shape also includes `bundle` and `bundleVersion`
  // (e.g. `{bundle: "synapse-collateral", bundleVersion: "0.5.2"}`). Those
  // aren't reachable here without threading bundle context through every
  // mutation handler — for `skill://<bundle>/<name>` we'd parse the URI
  // authority; for filesystem paths under the bundle skill roots we'd
  // derive the bundle from the path. Both also need the runtime's bundle
  // registry for the version lookup. Filed as a follow-up.
  return {
    content: textContent(
      "Bundle (Layer 1) skills ship with the bundle and are versioned with it. " +
        "To change one, publish a new bundle version — the platform cannot edit it in place.",
    ),
    structuredContent: {
      error: "skill_not_mutable_via_platform",
      layer: 1,
      suggested_action: "publish_new_bundle_version",
      message:
        "This skill ships with the bundle and is versioned with it. To change it, publish a new bundle version.",
    },
    isError: true,
  };
}

/**
 * Honest error message for a skill `id` that doesn't fit any known form.
 * Replaces the previous `(platform/workspace/user/builtin)` text — those
 * scope names are stale (the rename to `org/workspace/user/bundle` made
 * the message lie) and the `<scope>/<name>` shape it implied was never a
 * real input format. Tells the caller what `id` actually accepts.
 */
function unrecognizedIdMessage(id: string): string {
  return (
    `Skill id "${id}" is not a recognized form. Pass either ` +
    `(a) an absolute filesystem path returned by skills__list — typically under ` +
    `/data/skills, /data/workspaces/<wsId>/skills, or /data/users/<userId>/skills — ` +
    `or (b) a skill:// URI from a bundle (e.g. skill://collateral/main).`
  );
}

// Input shape for `skills__create`. Derived from the TypeBox schema in
// `./schemas/skills.ts`; the validator (validateToolInput) has already
// rejected anything that doesn't match before this runs, so the handler
// reads typed fields directly. `name` lives inside manifest (not at root)
// — same place as the on-disk frontmatter.
async function createSkill(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
): Promise<ToolResult> {
  const { scope, manifest, body } = input as unknown as SkillsCreateInput;
  const { name } = manifest;
  assertValidName(name);

  // Resolve the target dir first so the permission check uses the
  // *destination* path. For workspace/user creates this binds the wsId
  // / userId to the current request context (you can only create inside
  // your own workspace / user dir), and the path-derived membership
  // check still applies.
  let dir: string;
  try {
    dir = scopeDir(runtime, scope);
  } catch (err) {
    return errorResult(err);
  }
  const target = join(dir, `${name}.md`);
  const permission = await checkPathAccess(runtime, target, scope, "write");
  if (!permission.allowed) {
    return permissionDenied(permission.reason ?? "Permission denied", {
      path: target,
      scope,
      role: currentRoleHint(runtime, scope),
    });
  }

  if (existsSync(target)) {
    return errorResult(new Error(`Skill "${name}" already exists in ${scope} scope`));
  }

  // Fill in defaults the schema doesn't enforce so the on-disk
  // SkillManifest is complete. The LLM-facing schema treats metadata
  // sub-fields (keywords, triggers, etc.) as optional; the domain type
  // expects keywords and triggers as arrays. Normalize at the boundary
  // by defaulting to empty arrays when the caller omitted them.
  const fullManifest: SkillManifest = {
    name,
    description: manifest.description,
    type: manifest.type,
    priority: manifest.priority ?? 50,
    version: manifest.version ?? "1.0.0",
    ...(manifest.status ? { status: manifest.status } : {}),
    ...(manifest.metadata
      ? {
          metadata: {
            keywords: manifest.metadata.keywords ?? [],
            triggers: manifest.metadata.triggers ?? [],
            ...(manifest.metadata.category !== undefined
              ? { category: manifest.metadata.category }
              : {}),
            ...(manifest.metadata.tags !== undefined ? { tags: manifest.metadata.tags } : {}),
          },
        }
      : {}),
  };

  const validation = validateSkill(name, fullManifest, body);
  if (!validation.valid) {
    return errorResult(new Error(`Validation failed — ${validation.errors.join("; ")}`));
  }

  writeSkill(dir, name, fullManifest, body);
  await reloadBootSkills(runtime);
  eventSink.emit({
    type: "skill.created",
    data: { id: target, name, scope, type: fullManifest.type },
  });
  return {
    content: textContent(`Created ${scope} skill "${name}" → ${target}`),
    structuredContent: { id: target, name, scope },
    isError: false,
  };
}

// Input shape for `skills__update`. `manifest` is a partial of the
// create-shape — every field optional. Derived from the TypeBox schema
// in `./schemas/skills.ts`; the validator has already enforced shape.
async function updateSkillHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
  authoringGuidePath: string,
): Promise<ToolResult> {
  const { id, manifest: patch, body } = input as unknown as SkillsUpdateInput;
  if (!id) return errorResult(new Error("`id` is required"));

  // skill:// URIs are bundle-served by design — return the structured
  // not-mutable error so calling agents can branch on suggested_action
  // without parsing prose. (Filesystem path → scope is determined below.)
  if (id.startsWith(SKILL_URI_PREFIX)) return bundleNotMutable();
  const scope = scopeOfPath(runtime, id, authoringGuidePath);
  if (scope === "bundle") return bundleNotMutable();
  if (!scope) return errorResult(new Error(unrecognizedIdMessage(id)));

  // Existence before permission — a stale `id` should report "not found",
  // not "permission denied". See read handler for full rationale.
  if (!existsSync(id)) {
    return errorResult(
      new Error(
        `Skill not found at "${id}". The file may have been moved or deleted — ` +
          `call skills__list to get current paths.`,
      ),
    );
  }

  const permission = await checkPathAccess(runtime, id, scope, "write");
  if (!permission.allowed) {
    return permissionDenied(permission.reason ?? "Permission denied", {
      path: id,
      scope,
      role: currentRoleHint(runtime, scope),
    });
  }

  // Defense-in-depth: realpath the target and verify the link doesn't
  // escape the declared scope/tenant. Catches three classes of attack:
  //   - symlink to /etc/passwd (or anywhere outside workDir) — leaks
  //     contents via snapshotVersion's copyFileSync
  //   - symlink within {workDir}/workspaces/ but to a different
  //     workspace — cross-workspace exfiltration
  //   - symlink across scope tiers (workspace skill → user dir) —
  //     tier-jumping
  try {
    assertSymlinkBoundaryOrThrow(runtime, id, scope);
  } catch (err) {
    return errorResult(err);
  }

  const dir = dirname(id);
  const name = (id.split("/").pop() ?? "").replace(/\.md$/, "");
  if (!name) return errorResult(new Error(`Cannot derive skill name from path "${id}"`));

  snapshotVersion(id);

  // Build a Partial<SkillManifest> from the patch. `name` in the patch
  // is ignored since it's derived from the path (renaming is a separate
  // operation). Metadata sub-fields (keywords, triggers) are required
  // arrays in the domain type but optional in the LLM-facing schema, so
  // we default-to-empty when they're omitted — same boundary normalization
  // as createSkill.
  const partial: Partial<SkillManifest> | undefined = patch
    ? {
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.type !== undefined ? { type: patch.type } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.version !== undefined ? { version: patch.version } : {}),
        ...(patch.metadata !== undefined
          ? {
              metadata: {
                keywords: patch.metadata.keywords ?? [],
                triggers: patch.metadata.triggers ?? [],
                ...(patch.metadata.category !== undefined
                  ? { category: patch.metadata.category }
                  : {}),
                ...(patch.metadata.tags !== undefined ? { tags: patch.metadata.tags } : {}),
              },
            }
          : {}),
      }
    : undefined;
  updateSkill(dir, name, partial, body);
  await reloadBootSkills(runtime);

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
  authoringGuidePath: string,
): Promise<ToolResult> {
  const { id } = input as { id?: string };
  if (!id) return errorResult(new Error("`id` is required"));

  if (id.startsWith(SKILL_URI_PREFIX)) return bundleNotMutable();
  const scope = scopeOfPath(runtime, id, authoringGuidePath);
  if (scope === "bundle") return bundleNotMutable();
  if (!scope) return errorResult(new Error(unrecognizedIdMessage(id)));

  // Existence before permission — see updateSkillHandler for rationale.
  if (!existsSync(id)) {
    return errorResult(
      new Error(
        `Skill not found at "${id}". The file may have been moved or deleted — ` +
          `call skills__list to get current paths.`,
      ),
    );
  }

  const permission = await checkPathAccess(runtime, id, scope, "write");
  if (!permission.allowed) {
    return permissionDenied(permission.reason ?? "Permission denied", {
      path: id,
      scope,
      role: currentRoleHint(runtime, scope),
    });
  }

  // Symlink-boundary defense — see updateSkillHandler for rationale.
  try {
    assertSymlinkBoundaryOrThrow(runtime, id, scope);
  } catch (err) {
    return errorResult(err);
  }

  const dir = dirname(id);
  const name = (id.split("/").pop() ?? "").replace(/\.md$/, "");
  if (!name) return errorResult(new Error(`Cannot derive skill name from path "${id}"`));

  snapshotVersion(id);
  deleteSkill(dir, name);
  await reloadBootSkills(runtime);

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
  authoringGuidePath: string,
): Promise<ToolResult> {
  return updateSkillHandler(
    runtime,
    { id: input.id, manifest: { status } },
    eventSink,
    authoringGuidePath,
  );
}

async function moveScopeHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
  authoringGuidePath: string,
): Promise<ToolResult> {
  const { id, target_scope } = input as { id?: string; target_scope?: string };
  if (!id) return errorResult(new Error("`id` is required"));
  if (!target_scope || !WRITABLE_SCOPES.has(target_scope as WritableScope)) {
    return errorResult(
      new Error(`target_scope must be one of org | workspace | user (got "${target_scope}")`),
    );
  }
  if (id.startsWith(SKILL_URI_PREFIX)) return bundleNotMutable();
  const sourceScope = scopeOfPath(runtime, id, authoringGuidePath);
  if (sourceScope === "bundle") return bundleNotMutable();
  if (!sourceScope) {
    return errorResult(new Error(unrecognizedIdMessage(id)));
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

  // Symlink-boundary defense on the source path before reading +
  // copying. parseSkillFile + snapshotVersion both follow symlinks, so
  // a cross-tenant link would otherwise leak content into the target
  // location and into _versions/. See updateSkillHandler for full
  // rationale.
  try {
    assertSymlinkBoundaryOrThrow(runtime, id, sourceScope);
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
  await reloadBootSkills(runtime);

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
