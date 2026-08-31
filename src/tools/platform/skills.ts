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
 *   skills__loading_log    — replay the skill-load ledger (every channel)
 *
 * Catalog activation (`nb__use_skill`) is defined here too — it shares this
 * file's resolution and delivery machinery — but registers on the system-tools
 * source so it is kernel-direct. See {@link createUseSkillToolDef}.
 *
 * Resource surfaced:
 *   skill://skills/authoring-guide — Layer 1 vendored markdown
 *
 * Mutation tools (create/update/delete/activate/etc.) are Phase 3 — see the
 * comment block at the bottom of this file for the intended surface so the
 * next implementer registers them in the right place.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isToolEnabled, type ResolvedFeatures } from "../../config/features.ts";
import { collectDeliveredSkillNames } from "../../conversation/event-reconstructor.ts";
import type { ConversationEvent } from "../../conversation/types.ts";
import { textContent } from "../../engine/content-helpers.ts";
import {
  type EventSink,
  INTERNAL_TOOL_ANNOTATION,
  SKILL_ACTIVATED_META_KEY,
  SKILL_SUPPRESSION_META_KEY,
  type ToolResult,
} from "../../engine/types.ts";
import { ORG_ADMIN_ROLES } from "../../identity/types.ts";
import { log } from "../../observability/log.ts";
import { formatActivatedSkillBlock } from "../../prompt/compose.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import {
  projectSkillLoads,
  type SkillLoadedBy,
  type SkillLoadRow,
} from "../../skills/load-ledger.ts";
import { parseSkillContent, parseSkillFile, readSkillMtime } from "../../skills/loader.ts";
import { resolveLoadingMechanism } from "../../skills/loading.ts";
import { SKILL_NAME_PATTERN } from "../../skills/schemas/skill-manifest.ts";
import { toolMatches } from "../../skills/select.ts";
import { approxTokens } from "../../skills/tokens.ts";
import { MAX_SKILL_BODY_CHARS, truncateMarkdownToBudget } from "../../skills/truncate.ts";
import type { Skill, SkillManifest } from "../../skills/types.ts";
import { validateSkill } from "../../skills/validator.ts";
import {
  isSnapshotPath,
  listSkillVersions,
  readSkillVersionRaw,
  snapshotSkillVersion,
} from "../../skills/versions.ts";
import { deleteSkill, updateSkill, writeSkill } from "../../skills/writer.ts";
import { splitInnerToolName } from "../../util/tool-name.ts";
import { canWriteWorkspaceScoped } from "../../workspace/authz.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import type {
  SkillDetail,
  SkillSummary,
  SkillsListOutput,
  SkillsReadOutput,
  SkillsUseOutput,
} from "./schemas/skills.ts";
import {
  SkillsActivateInput,
  SkillsCreateInput,
  SkillsDeactivateInput,
  SkillsDeleteInput,
  SkillsHistoryInput,
  SkillsListInput,
  SkillsLoadingLogInput,
  SkillsReadInput,
  SkillsRestoreInput,
  SkillsSetStatusInput,
  SkillsUpdateInput,
  UseSkillInput,
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
  "Filter by `scope` (org | workspace | user | bundle), `layer` (1 | 3), `loading_strategy` (always | dynamic), " +
  "`tool_affinity` (a tool name; returns skills whose `tool-affinity` glob matches it), " +
  "`status` (active | disabled), or `modified_since` (ISO 8601). " +
  "Returns id, name, layer, scope, status, token count, and source metadata for each skill. " +
  "Use this to answer 'what skills do I have?' or 'what's available for the active tool set?'";

const SKILLS_READ_DESCRIPTION =
  "Read one skill by id. The `id` is either a filesystem path (returned by `skills__list`) " +
  "or a bundle skill:// URI. Returns the full markdown body plus parsed manifest fields (name, " +
  "description, loading_strategy, priority, scope, layer, tool_affinity, triggers, status). " +
  "Always call `skills__list` first to discover ids — bare names and scope-prefixed forms " +
  "(e.g. `org/foo`) are NOT valid input.";

const SKILLS_LOADING_LOG_DESCRIPTION =
  "Replay the skill-load ledger from conversation logs — every channel a skill can reach the " +
  "model through, not just the ones composed into the system prompt. Returns one row per skill " +
  "load: timestamp, conversation id, run id, skill, `loaded_by` channel, tokens, and scope. " +
  "Filter by `conversation_id`, `skill` (name or id), `loaded_by`, and a `since`/`until` ISO 8601 " +
  "window. Use to audit which skills fired across a window of activity, to compare how often a " +
  "skill is loaded by model activation versus by tool use, or to debug why a particular skill " +
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
  "`manifest` patch (any subset of the create-shape fields) and/or a `body`. When you pass a " +
  "`body` you MUST also pass `body_mode`: `append` adds it to the skill (use this to add a " +
  "rule — it keeps everything already there), `replace` overwrites the whole body. Snapshots " +
  "the current version to `_versions/` first; `skills__history` lists those snapshots and " +
  "`skills__restore` puts one back. Bundle (Layer 1) skills are not editable.";

// Tool input schemas live in `./schemas/skills.ts` — see the catalog at
// `./schemas/catalog.ts`. The LLM-facing create/update input is a `Pick` of
// the canonical manifest: `name`, `description`, `allowed-tools`, and the
// authorable NimbleBrain fields (`loading-strategy`, `priority`, `status`,
// `tool-affinity`, `triggers`). `provenance` and `scope` are NOT authorable —
// the writer stamps `provenance` and the loader stamps `scope` from the
// directory tier.

const SKILLS_HISTORY_DESCRIPTION =
  "List the saved snapshots of a skill, newest first. Every `update`, `delete`, and `restore` " +
  "snapshots the file first, so this is the undo history. Returns version ids to pass to " +
  "`skills__read` (`version`) to inspect one, or `skills__restore` to put one back.";

const SKILLS_RESTORE_DESCRIPTION =
  "Restore a skill's body and manifest from a snapshot listed by `skills__history`. The current " +
  "version is snapshotted first, so a restore is itself undoable. Use this to recover content " +
  'an over-broad `body_mode: "replace"` discarded.';

const SKILLS_DELETE_DESCRIPTION =
  "Delete a Layer 3 skill. The `id` is the filesystem path returned by `skills__list`. " +
  "Snapshots to `_versions/` before removing the live file. Confirm with the user before " +
  "deleting org- or workspace-scope skills. Bundle (Layer 1) skills cannot be deleted via " +
  "the platform — those ship with the bundle.";

const SKILLS_SET_STATUS_DESCRIPTION =
  "Durably enable or disable a skill by writing `status` to its frontmatter. INTERNAL: the Skills " +
  "settings page invokes this by name; the model never sees it. The blast radius is why — a " +
  "user-scope skill's file is read by every conversation that user has, in every workspace, so " +
  "flipping it is a decision for a human looking at the surface that shows what they are changing. " +
  "The agent's `activate`/`deactivate` mute for one conversation instead.";

const SKILLS_ACTIVATE_DESCRIPTION =
  "Un-mute a skill previously muted with `deactivate` in this conversation, so it composes again " +
  "from the next turn. Scope is this conversation only. This does NOT load a skill on demand — for " +
  "that use `nb__use_skill`, which delivers the body immediately.";

const USE_SKILL_DESCRIPTION =
  "Load a skill from the Skill Catalog into this conversation. Pass `name` exactly as listed " +
  "in the Skill Catalog section of your instructions — the catalog is the authoritative name " +
  "list (`skills__list` covers only authored skills, not bundle-published ones or connector " +
  "overlays); on a miss the error lists every valid name. The skill's full guidance comes " +
  "back in the tool result — apply it to the task at hand. A skill already delivered in this " +
  "conversation returns a short 'already loaded' note instead of a second copy. Read-only: " +
  "does NOT change the skill's stored status (that is `activate`/`deactivate`).";

const SKILLS_DEACTIVATE_DESCRIPTION =
  "Mute a skill for THIS CONVERSATION — it stops composing into your context from the next turn. " +
  "Scope is this conversation only: nothing is written to the skill, and the user's other chats and " +
  "workspaces are unaffected. Undo with `activate`. Use when a skill is not relevant to the task at " +
  "hand. To turn a skill off permanently the user does it in Skills settings — you cannot, and " +
  "should say so rather than muting and calling it done.";

// ── Source factory ───────────────────────────────────────────────────────

/**
 * Create the skills platform source.
 *
 * The `eventSink` parameter is currently unused but kept on the signature to
 * mirror `createInstructionsSource` and reserve the wiring for Phase 3
 * mutation tools, which will emit `skill.created` / `skill.updated` /
 * `skill.deleted` engine events.
 */
/**
 * Skills tools that stay reachable inside an unattended run: the read-only
 * half. Everything else in the namespace — the authoring tools, and any tool
 * added to it later — is barred, so the boundary fails CLOSED as the surface
 * grows (an allowlist, not a denylist), matching
 * {@link AUTOMATIONS_TASK_SAFE_TOOLS}.
 *
 * A skill is durable, cross-conversation guidance the runtime composes into a
 * prompt on its own: `loading_strategy: always` reaches every later turn, and
 * tool affinity reaches every turn that touches the matching tools. A task run
 * fires as its owner with no human present to confirm, and routinely ingests
 * untrusted content (email, web pages, tickets). A write from inside one would
 * put attacker-authored text into future interactive sessions with nothing
 * standing between them — a foothold that outlives the run and then loads
 * itself. That is the argument `createInstructionsSource` makes for the same
 * wall, and it is stronger here: instructions are one document a scope opts
 * into, while a skill can auto-load on a tool match and there can be many.
 *
 * Reads stay open deliberately. An automation that audits the catalog and
 * reports what it found — stale skills, overlapping guidance, a recommendation
 * to retire one — is useful and changes nothing; it hands its conclusions to a
 * human who makes the change from an interactive session.
 */
const SKILLS_TASK_SAFE_TOOLS: ReadonlySet<string> = new Set([
  "list",
  "read",
  "history",
  "loading_log",
]);

/**
 * Whether a `skills__*` wire name is barred from an unattended run.
 *
 * Two layers read this one predicate, the same split
 * {@link isTaskForbiddenIdentityTool} uses. Surfacing subtraction — in
 * `executeTask` for the run itself, and in the delegate default active set for
 * a sub-agent spawned inside one — keeps the model from being shown a tool it
 * cannot call. {@link createSkillsSource} refuses them at dispatch, so the
 * wall holds at any delegation depth and regardless of what was surfaced.
 * Surfacing is the courtesy; the source is the boundary.
 *
 * Both surfacing sites gate on `RequestContext.unattended` themselves; this
 * predicate answers only "is this name in the barred half", so a caller on a
 * path that also serves interactive chat must gate it.
 *
 * Names outside the namespace are not this policy's business and return false.
 */
export function isTaskForbiddenSkillTool(wireName: string): boolean {
  const { sourcePrefix, bareToolName, hasSeparator } = splitInnerToolName(wireName);
  // `hasSeparator` is load-bearing, not decoration: without it a bare `skills`
  // (no source segment) reports `sourcePrefix === "skills"` with the whole name
  // as the tool, and would be barred as an unrecognised mutation. A name with
  // no source segment is not in this namespace and is not this policy's
  // business.
  if (!hasSeparator || sourcePrefix !== SKILLS_SOURCE_NAME) return false;
  // Anything else in the namespace is forbidden, including a malformed
  // `skills__` whose tool segment is empty — the allowlist fails closed on a
  // name it does not recognise, which is the point of spelling it this way.
  return !SKILLS_TASK_SAFE_TOOLS.has(bareToolName);
}

export function createSkillsSource(
  runtime: Runtime,
  eventSink: EventSink,
  features?: ResolvedFeatures,
): McpSource {
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
          // Construct via the canonical envelope so a shape drift on
          // either side surfaces at compile time. The cast at the
          // boundary is needed because `structuredContent`'s wire type
          // is `Record<string, unknown>`, which TS doesn't infer
          // structural interfaces into; validation still happens on
          // `out`'s declaration.
          const out: SkillsListOutput = { skills: list };
          return {
            content: textContent(summarizeList(list)),
            structuredContent: out as unknown as Record<string, unknown>,
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
          return await readSkillHandler(runtime, authoringGuidePath, input);
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
          const loads = await loadingLog(runtime, input);
          return {
            content: textContent(summarizeLog(loads)),
            structuredContent: { loads },
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
      name: "history",
      description: SKILLS_HISTORY_DESCRIPTION,
      inputSchema: SkillsHistoryInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await historySkillHandler(runtime, input, authoringGuidePath);
        } catch (err) {
          return errorResult(err);
        }
      },
    },
    {
      name: "restore",
      description: SKILLS_RESTORE_DESCRIPTION,
      inputSchema: SkillsRestoreInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          return await restoreSkillHandler(runtime, input, eventSink, authoringGuidePath);
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
      name: "set_status",
      description: SKILLS_SET_STATUS_DESCRIPTION,
      annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
      inputSchema: SkillsSetStatusInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const status = input.status === "disabled" ? "disabled" : "active";
          return await updateSkillHandler(
            runtime,
            { id: input.id, manifest: { status } },
            eventSink,
            authoringGuidePath,
            { allowStatus: true },
          );
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
          return await setStatusHandler(runtime, input, "active");
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
          return await setStatusHandler(runtime, input, "disabled");
        } catch (err) {
          return errorResult(err);
        }
      },
    },
  ];

  // A feature-disabled tool is never BUILT. That is the enforcement — no
  // listing has to hide it and no door has to refuse it, which is what
  // `src/config/privilege.ts` relies on when it skips confirmation for a
  // disabled tool. `createSystemTools` gates `nb__*` at the same point.
  //
  // `FEATURE_TOOL_MAP` keys on the WIRE name and these defs carry the bare one,
  // so qualify before asking. Bare `create` / `delete` are deliberately absent
  // from that map: they are too generic to gate globally, since any bundle may
  // name a tool `create`.
  //
  // No `features` means no filtering, matching `createSystemTools`. The
  // production path always passes them; the parameter is optional for unit
  // fixtures that build this source against a stub runtime.
  //
  // Ordered BEFORE the wall on purpose, and the two must stay composed: these
  // are independent controls answering different questions (does the operator
  // allow this tool to exist / may an unattended run call it), so the wall
  // wraps whatever survives this filter. Applying either one INSTEAD of the
  // other at the `tools:` argument below is the failure mode this ordering
  // removes — and it is not one the suite would catch, because a `features`
  // branch is only taken in production (unit fixtures omit the parameter).
  const enabled: InProcessTool[] = features
    ? tools.filter((t) => isToolEnabled(`${SKILLS_SOURCE_NAME}__${t.name}`, features))
    : tools;

  // Unattended-run wall. Enforced HERE, wrapping the assembled tool list,
  // because this is the single dispatch point every caller funnels through —
  // the top-level run AND a delegated sub-agent at any depth. `unattended`
  // rides the ambient request context (set by `executeTask`, preserved across
  // the per-call restamp), so the wall does not depend on which engine or
  // router dispatched the call, or on the tool ever having been surfaced to
  // the model. Same placement and reasoning as `createAutomationsSource` and
  // `createInstructionsSource`.
  const walled: InProcessTool[] = enabled.map((tool) =>
    SKILLS_TASK_SAFE_TOOLS.has(tool.name)
      ? tool
      : {
          ...tool,
          handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
            if (getRequestContext()?.unattended) {
              return errorResult(
                new Error(
                  `Tool "${SKILLS_SOURCE_NAME}__${tool.name}" is not available inside an ` +
                    "unattended automation run. A skill is durable guidance that loads " +
                    "itself into later conversations, and there is no one present to " +
                    "confirm the change. Read and report from the run; write the skill " +
                    "from an interactive session.",
                ),
              );
            }
            return tool.handler(input);
          },
        },
  );

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
          return "# Authoring Guide\n\n(content pending)\n";
        },
      },
    ],
  ]);

  return defineInProcessApp(
    {
      name: SKILLS_SOURCE_NAME,
      version: "1.0.0",
      tools: walled,
      resources,
    },
    eventSink,
  );
}

// ── Internal handler logic ───────────────────────────────────────────────

interface ListInput {
  scope?: string;
  layer?: number;
  loading_strategy?: "always" | "dynamic";
  tool_affinity?: string;
  status?: string;
  modified_since?: string;
}

// Local aliases for the canonical output shapes from `schemas/skills.ts`.
// Server and web both import from there — this alias just keeps the
// historical local name in this file's body so the diff stays small.
type ListedSkill = SkillSummary;
type ReadResult = SkillDetail;

function skillToListed(skill: Skill): ListedSkill {
  const m = skill.manifest;
  const path = skill.sourcePath || undefined;
  const id = path || `skill-in-memory:${m.name}`;
  const mechanism = resolveLoadingMechanism(m);
  return {
    id,
    name: m.name,
    layer: 3,
    scope: m.scope ?? "org",
    status: m.status,
    tokens: approxTokens(skill.body),
    source: path ? { path } : {},
    ...(m.description ? { description: m.description } : {}),
    ...(path ? { modifiedAt: readSkillMtime(path) } : {}),
    loadingStrategy: m.loadingStrategy,
    ...(m.toolAffinity && m.toolAffinity.length > 0 ? { toolAffinity: m.toolAffinity } : {}),
    ...(m.triggers && m.triggers.length > 0 ? { triggers: m.triggers } : {}),
    priority: m.priority,
    loading: { wouldLoad: mechanism !== "none", mechanism },
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
      if (isListableLayer3Skill(skill, layer1SourcePaths)) out.push(skillToListed(skill));
    }
  }

  // Layer 1: vendored bundle resources. Phase 2 surfaces only the platform-
  // authored authoring guide (`skill://skills/authoring-guide`). Future
  // bundles that publish their own `skill://...` resources will be
  // discovered via a runtime resource scan; for Phase 2 the catalog is
  // static and small.
  if (includeLayer1) {
    const entry = buildAuthoringGuideEntry(authoringGuidePath);
    if (entry) out.push(entry);
  }

  // Apply scalar filters
  return out.filter((s) => matchesListFilters(s, filter));
}

/**
 * True when a Layer 3 skill belongs in `skills__list`: not a Layer 1 resource
 * that would double-list, and not a connector-skill overlay.
 */
function isListableLayer3Skill(skill: Skill, layer1SourcePaths: Set<string>): boolean {
  // Skills surfaced as Layer 1 resources (today: the vendored authoring
  // guide) are filtered out here so they don't appear twice — once via
  // their file path through the contextSkills pool and again as a Layer 1
  // entry.
  if (skill.sourcePath && layer1SourcePaths.has(resolve(skill.sourcePath))) return false;
  // Connector-skill overlays are surface-once-into-history candidates,
  // not authored skills — they live in a separate `connector-skills/` store
  // that `loadConversationSkills` never reads. Filter on the provenance
  // origin as defense-in-depth so an overlay can never leak into the
  // authored-skill listing even if a future change merges the pools.
  if (skill.manifest.provenance?.origin === "connector") return false;
  return true;
}

/**
 * Build the Layer 1 list entry for the vendored authoring guide, or null when
 * the guide file is absent or unparseable.
 */
function buildAuthoringGuideEntry(authoringGuidePath: string): ListedSkill | null {
  if (!existsSync(authoringGuidePath)) return null;
  const skill = parseSkillFile(authoringGuidePath);
  if (!skill) return null;
  const tokens = approxTokens(skill.body);
  const mechanism = resolveLoadingMechanism(skill.manifest);
  return {
    id: AUTHORING_GUIDE_URI,
    name: skill.manifest.name,
    layer: 1,
    scope: "bundle",
    status: skill.manifest.status,
    tokens,
    source: { uri: AUTHORING_GUIDE_URI, path: authoringGuidePath, bundle: "nb__skills" },
    ...(skill.manifest.description ? { description: skill.manifest.description } : {}),
    modifiedAt: readSkillMtime(authoringGuidePath),
    loadingStrategy: skill.manifest.loadingStrategy,
    ...(skill.manifest.toolAffinity && skill.manifest.toolAffinity.length > 0
      ? { toolAffinity: skill.manifest.toolAffinity }
      : {}),
    ...(skill.manifest.triggers && skill.manifest.triggers.length > 0
      ? { triggers: skill.manifest.triggers }
      : {}),
    priority: skill.manifest.priority,
    loading: { wouldLoad: mechanism !== "none", mechanism },
  };
}

/** Scalar + tool-affinity filter for `skills__list`: true when `s` passes every provided filter. */
function matchesListFilters(s: ListedSkill, filter: ListInput): boolean {
  if (filter.scope && s.scope !== filter.scope) return false;
  if (filter.loading_strategy && s.loadingStrategy !== filter.loading_strategy) return false;
  if (filter.status && s.status !== filter.status) return false;
  if (filter.modified_since && s.modifiedAt && s.modifiedAt < filter.modified_since) return false;
  if (filter.tool_affinity !== undefined && !matchesToolAffinityFilter(s, filter.tool_affinity)) {
    return false;
  }
  return true;
}

/**
 * Tool-affinity filter: an empty/whitespace target matches nothing; otherwise
 * the skill must carry a `tool-affinity` pattern that matches the target.
 */
function matchesToolAffinityFilter(s: ListedSkill, toolAffinity: string): boolean {
  // Short-circuit empty/whitespace-only target: an empty string would
  // match `*`-pattern skills via `toolMatches`, but the operator's
  // intent is clearly "no tool", which should match nothing rather
  // than every wildcard skill.
  const target = toolAffinity.trim();
  if (target.length === 0) return false;
  const patterns = s.toolAffinity ?? [];
  if (patterns.length === 0) return false;
  return patterns.some((p) => toolMatches(target, p));
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
 * check, but `snapshotSkillVersion`'s copy (and `readSkillById`'s
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
 * Called from update / delete (after existsSync, before
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

/**
 * `skills__read` core: resolve one skill by id (a `skill://` URI or a
 * filesystem path), enforcing scope permission and the symlink boundary
 * before reading. Throws on unexpected errors; the tool wrapper turns those
 * into an `isError` result.
 */
/**
 * Render one `_versions/` snapshot as a read result. Split out of
 * `readSkillHandler` so the live-read path keeps its shape; the caller has
 * already run every scope/permission/symlink gate.
 */
function renderSkillVersion(id: string, version: string, isUri: boolean): ToolResult {
  if (isUri) {
    return errorResult(
      new Error("`version` is not supported for `skill://` ids — bundle skills have no history."),
    );
  }
  const raw = readSkillVersionRaw(id, version);
  if (raw === null) {
    return {
      content: textContent(
        `No version "${version}" for "${id}". Call skills__history to list available versions.`,
      ),
      isError: true,
    };
  }
  const parsed = parseSkillContent(raw, id, { cap: false });
  if (!parsed) {
    return errorResult(new Error(`Snapshot "${version}" of "${id}" could not be parsed.`));
  }
  return {
    content: textContent(`Version ${version} of ${id}\n\n${parsed.body}`),
    structuredContent: {
      id,
      version,
      body: parsed.body,
      manifest: parsed.manifest as unknown as Record<string, unknown>,
    },
    isError: false,
  };
}

async function readSkillHandler(
  runtime: Runtime,
  authoringGuidePath: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
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
  // A snapshot read runs the SAME scope/permission/symlink gates above and
  // only then swaps which file is parsed — history must never be a side door
  // to content the live path would refuse.
  const version = typeof input.version === "string" ? input.version : undefined;
  if (version) return renderSkillVersion(id, version, isUri);
  const result = await readSkillById(runtime, authoringGuidePath, id);
  if (!result) {
    return {
      content: textContent(`Skill not found: ${id}`),
      isError: true,
    };
  }
  // Compile-time drift coverage on the read shape: `out`'s type
  // pins it to the canonical `SkillsReadOutput`. Wire cast is
  // the same shim explained in the `list` handler.
  const out: SkillsReadOutput = result;
  return {
    // `content` carries the full body + manifest because the
    // engine never surfaces `structuredContent` to the model;
    // `structuredContent` keeps the typed copy for `/mcp` clients
    // and the UI. See `renderRead`.
    content: textContent(renderRead(result)),
    structuredContent: out as unknown as Record<string, unknown>,
    isError: false,
  };
}

/**
 * `nb__use_skill` tool definition, registered by the system-tools factory
 * rather than on this source.
 *
 * The catalog it reads from is rendered into the stable system prefix on
 * every turn, so the move to activate against it must be reachable on every
 * turn too. Kernel tools are the only ones that are: every real workspace
 * exceeds the Tier-1 direct-tool budget (the always-direct kernel set alone
 * does), so a non-kernel tool is proxied and costs an `nb__manage_tools`
 * promote before first use — a tools-block rewrite, the most expensive cache
 * bust in the request, paid in exactly the conversations where the catalog is
 * doing its job. `nb__` makes it kernel-direct by construction
 * (`isKernelTool` in `tools/surfacing.ts`).
 *
 * Its siblings stay on the `skills` source, and the split is the DRIVER axis
 * that file documents, not an exception to it: `skills__list`/`read`/`create`
 * are authoring tools the agent reaches for while *editing* skills, which is
 * occasional and worth a promote. This one is how the agent *uses* a skill
 * mid-task. Different audience, different resting place.
 */
export function createUseSkillToolDef(runtime: Runtime): InProcessTool {
  return {
    name: "use_skill",
    description: USE_SKILL_DESCRIPTION,
    inputSchema: UseSkillInput,
    handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
      try {
        return await handleUseSkill(runtime, input);
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

/**
 * `nb__use_skill` core: deliver a catalog skill's full body into the
 * conversation, exactly once.
 *
 * Resolution goes through {@link Runtime.listActivatableSkills} — the same
 * workspace-walled union the catalog is projected from — so a skill in
 * another workspace can neither be named nor delivered here. The
 * already-delivered check reads the conversation's own event log (the
 * request-context conversation, not a caller-supplied id): a prior
 * `skill.activated` OR surface-once `connector.skill.injected` for the same
 * name answers "already loaded" instead of a second copy, with the same
 * compaction-resurface allowance the overlay path has.
 *
 * On delivery, the result carries the `SKILL_ACTIVATED_META_KEY` marker; the
 * ENGINE (not this handler) emits the persisted `skill.activated` event from
 * it, because only the engine knows the runId/toolCallId and holds the run's
 * surface-once dedup set. The body itself persists via the normal `tool.done`
 * event — no synthetic history message, no `connector.skill.injected`.
 */
async function handleUseSkill(
  runtime: Runtime,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const { name } = input as unknown as UseSkillInput;
  const { wsId, userId } = resolveCallContext(runtime);
  if (!wsId) {
    return {
      content: textContent(
        "nb__use_skill requires a workspace in scope — call it from a chat or task session.",
      ),
      isError: true,
    };
  }

  const activatable = await runtime.listActivatableSkills(wsId, userId);
  const skill = activatable.find((s) => s.name === name);
  if (!skill) {
    // Names, not bodies: the miss message must stay small however large the
    // catalog is. `activatable` is already sorted.
    const hint =
      activatable.length > 0
        ? ` Available skills: ${activatable.map((s) => s.name).join(", ")}.`
        : " No skills are available to load in this workspace.";
    return {
      content: textContent(`Unknown skill "${name}".${hint}`),
      isError: true,
    };
  }

  // Already-delivered check against the CURRENT conversation (from request
  // context — never a caller-named id, so no ownership gate is needed).
  // Task runs persist no conversation, so they skip the check and always
  // deliver — a task is a single fresh run.
  const convId = getRequestContext()?.conversationId;
  if (convId) {
    const events = await readConvEvents(runtime, convId);
    if (events && collectDeliveredSkillNames(events).has(name)) {
      const out: SkillsUseOutput = { status: "already_loaded", name };
      return {
        content: textContent(
          `Skill "${name}" is already loaded in this conversation — its guidance is in context above; no need to load it again.`,
        ),
        structuredContent: out as unknown as Record<string, unknown>,
        isError: false,
      };
    }
  }

  // Cap the delivered body with the same budget every other prompt-bound
  // skill body gets (bundle `skill://` discovery caps at read; filesystem
  // bodies are capped here).
  const capped = truncateMarkdownToBudget(skill.body, MAX_SKILL_BODY_CHARS);
  const tokens = approxTokens(capped.body);
  const out: SkillsUseOutput = { status: "loaded", name: skill.name, scope: skill.scope, tokens };
  return {
    content: textContent(formatActivatedSkillBlock(skill.name, skill.scope, capped.body)),
    structuredContent: out as unknown as Record<string, unknown>,
    isError: false,
    _meta: {
      [SKILL_ACTIVATED_META_KEY]: { skillName: skill.name, scope: skill.scope, tokens },
    },
  };
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
      priority: m.priority,
      loadingStrategy: m.loadingStrategy,
      ...(m.toolAffinity && m.toolAffinity.length > 0 ? { toolAffinity: m.toolAffinity } : {}),
      ...(m.triggers && m.triggers.length > 0 ? { triggers: m.triggers } : {}),
      status: m.status,
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

interface LoadingLogInput {
  conversation_id?: string;
  skill?: string;
  loaded_by?: SkillLoadedBy;
  since?: string;
  until?: string;
}

/**
 * Replay the skill-load ledger — every channel, not just `skills.loaded`.
 *
 * The projection lives in `skills/load-ledger.ts`; this function owns the
 * access gate, the conversation set, and the filters. When `conversation_id`
 * is provided, scan just that conversation (owner-gated, and resolvable from
 * any workspace — the same by-id read a deep link does); otherwise scan every
 * conversation the caller owns in the active workspace. The cross-conv scan
 * reads each jsonl in turn — intentionally simple for Phase 2; a derived index
 * lands in Phase 6.
 */
async function loadingLog(
  runtime: Runtime,
  input: Record<string, unknown>,
): Promise<SkillLoadRow[]> {
  const filter = input as LoadingLogInput;

  // Stage 1 single-owner: every conversation read here must belong to
  // the caller. Without an identity we refuse rather than scan — the
  // top-level store holds every user's conversations and an
  // unauthenticated scan would leak peer skills.loaded events.
  const identity = runtime.getCurrentIdentity();
  if (!identity) {
    throw new Error("skills__loading_log requires an authenticated identity");
  }
  const access = { userId: identity.id };

  const convIds = await resolveLoadingLogConvIds(runtime, filter, access);

  const out: SkillLoadRow[] = [];
  for (const convId of convIds) {
    const events = await readConvEvents(runtime, convId);
    if (!events) continue;
    for (const row of projectSkillLoads(convId, events)) {
      if (matchesLoadingLogFilter(row, filter)) out.push(row);
    }
  }
  // Sort by timestamp for stable ordering across conversations.
  out.sort((a, b) => a.ts.localeCompare(b.ts));
  return out;
}

/** Resolve the conversation ids to scan for `skills__loading_log`, scoped to the caller. */
async function resolveLoadingLogConvIds(
  runtime: Runtime,
  filter: LoadingLogInput,
  access: { userId: string },
): Promise<string[]> {
  if (filter.conversation_id) {
    // Explicit-id branch: verify ownership before reading events.
    // `findConversation(id, access)` returns null for both not-found
    // and foreign-owner, so we treat them the same: no entries.
    const owned = await runtime.findConversation(filter.conversation_id, access);
    if (!owned) return [];
    return [filter.conversation_id];
  }
  return listOwnedConversationIds(runtime, access);
}

/**
 * True when a ledger row passes the loading-log filters.
 *
 * `skill` matches either the stable id or the name: only `skills.loaded`
 * records an id, so an id-only match would silently drop every `tool_use` and
 * `activation` row — the two channels this tool exists to surface — and make a
 * per-skill query look like the skill never loaded.
 */
function matchesLoadingLogFilter(row: SkillLoadRow, filter: LoadingLogInput): boolean {
  if (filter.since && row.ts < filter.since) return false;
  if (filter.until && row.ts > filter.until) return false;
  if (filter.loaded_by && row.loaded_by !== filter.loaded_by) return false;
  if (filter.skill && row.skill !== filter.skill && row.skill_id !== filter.skill) return false;
  return true;
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
  // The locator resolves the conversation's workspace store (null if not found,
  // which folds in the existence check).
  const store = await runtime.resolveConversationStore(convId);
  if (!store) return null;
  return store.readEvents(convId);
}

/**
 * Conversation ids owned by the caller IN THE ACTIVE WORKSPACE. Goes through
 * the locator's `list(workspaceId, opts, access)`, which applies the same
 * workspace wall and ownership filter the platform conversation tools use.
 * Walks paginated results so a workspace with many owned conversations is
 * covered.
 *
 * Workspace-scoped because `skills` is a workspace source and skills are
 * workspace-tiered: "which skills loaded" is a question about THIS workspace.
 * The unscoped version answered it across every workspace the caller belonged
 * to, contradicting this function's own contract.
 */
async function listOwnedConversationIds(
  runtime: Runtime,
  access: { userId: string },
): Promise<string[]> {
  const wsId = runtime.requireWorkspaceId();
  const ids: string[] = [];
  let cursor: string | undefined;
  // Fixed page size; enough that a normal tenant gets one page. The locator's
  // `list` is in-memory after populate, so paging is cheap. Loop until done.
  while (true) {
    const page = await runtime.listConversations(
      wsId,
      { limit: 200, ...(cursor ? { cursor } : {}) },
      access,
    );
    for (const c of page.conversations) ids.push(c.id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return ids;
}

function errorResult(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: textContent(message),
    isError: true,
  };
}

// ── Human-readable renderings for tool `content` field ─────────────────
//
// The engine surfaces only `content` to the model — `structuredContent`
// reaches `/mcp` clients and the UI but never the in-process agent loop.
// So `content` must carry everything the model needs to act:
//
//   - For *status/enumeration* tools (`loading_log`) a short summary line
//     is sufficient; the model only needs the gist.
//   - For *enumeration the model must read* (`list`) and *document fetch*
//     (`read`) the payload itself goes in `content` — IDs for `list`, the
//     full body + manifest for `read` — because the structured copy is
//     invisible to the model. `files__read` and `conversations__get` embed
//     their bodies the same way.

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
    if (s.loadingStrategy) tags.push(s.loadingStrategy);
    if (s.priority != null) tags.push(`p${s.priority}`);
    if (s.status && s.status !== "active") tags.push(s.status);
    const meta = `(${tags.join(" ")})`;
    const desc = s.description ? ` — ${s.description.slice(0, 100)}` : "";
    // Flag dead skills (no strategy, no triggers, no tool affinity) so the
    // zero-signal failure mode is visible in the model-facing content.
    const warn = s.loading?.wouldLoad === false ? " ⚠ never loads" : "";
    return `- ${s.id} ${meta}${desc}${warn}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

function summarizeRead(skill: ReadResult): string {
  const m = skill.metadata;
  const parts = [`${m.name} (L${skill.layer} ${skill.scope})`];
  // `loads:` reports the resolved MECHANISM (always / tool_affinity / trigger /
  // none) — how the skill actually reaches the prompt — not the raw
  // `loadingStrategy` field (which renderRead prints separately below). A
  // `dynamic` skill with tool-affinity loads via `tool_affinity`; one with
  // neither signal is `none` (catalog-only, inert until the catalog ships).
  if (m.loadingStrategy) parts.push(`loads: ${resolveLoadingMechanism(m)}`);
  return parts.join(" · ");
}

// Render the full skill for the model-visible `content` field: header,
// then the parsed manifest fields the description promises, then the
// markdown body. `read`'s entire purpose is to deliver the skill to the
// caller, and the body lives only here for the in-process agent (the
// structured copy never reaches the model). Manifest leads and the body
// trails so that if `boundToolResultForModel` trims at
// MAX_TOOL_RESULT_CHARS the metadata survives and only the body tail is
// cut — the same small-first ordering `conversations__get` uses.
//
// The field list is explicit (not a spread of `metadata`) so it stays a
// deliberate subset — the same minimum-sufficient-surface contract the
// schema uses. Keep it in sync with `SKILLS_READ_DESCRIPTION` and
// `SkillDetail.metadata` when adding a field: type, description, renderer,
// and tests move together.
function renderRead(skill: ReadResult): string {
  const m = skill.metadata;
  const fields = [summarizeRead(skill), `id: ${skill.id}`, `source: ${skill.source}`];
  if (m.description) fields.push(`description: ${m.description}`);
  if (m.loadingStrategy) fields.push(`loading-strategy: ${m.loadingStrategy}`);
  if (m.priority != null) fields.push(`priority: ${m.priority}`);
  // `status` always renders — `buildReadResult` defaults it to "active", so
  // the description's promise of a `status` field holds for every skill
  // (an audit's first question is "active or disabled?").
  if (m.status) fields.push(`status: ${m.status}`);
  if (m.toolAffinity?.length) fields.push(`tool-affinity: ${m.toolAffinity.join(", ")}`);
  if (m.triggers?.length) fields.push(`triggers: ${m.triggers.join(", ")}`);
  if (skill.modifiedAt) fields.push(`modified: ${skill.modifiedAt}`);
  return `${fields.join("\n")}\n\n---\n\n${skill.content}`;
}

function summarizeLog(rows: SkillLoadRow[]): string {
  if (rows.length === 0) return "No skill loads match the filters.";
  const conversations = new Set(rows.map((r) => r.conv_id)).size;
  // Channel breakdown is the point of the ledger — a channel that never fires
  // should be legible as a missing key, not inferred from a total.
  const byChannel = new Map<SkillLoadedBy, number>();
  for (const r of rows) byChannel.set(r.loaded_by, (byChannel.get(r.loaded_by) ?? 0) + 1);
  const breakdown = [...byChannel.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([channel, n]) => `${channel} ${n}`)
    .join(", ");
  const plural = rows.length === 1 ? "" : "s";
  const convPlural = conversations === 1 ? "" : "s";
  return `${rows.length} skill load${plural} across ${conversations} conversation${convPlural} (${breakdown})`;
}

// ── Mutation handlers ────────────────────────────────────────────────────

type WritableScope = "org" | "workspace" | "user";

interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

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

  const workDir = runtime.getWorkDir();

  if (scope === "bundle") return bundleAccess(mode);
  if (scope === "org") return orgAccess(mode, ORG_ADMIN_ROLES.has(identity.orgRole));
  if (scope === "user") return userScopeAccess(path, workDir, identity);
  return workspaceScopeAccess(runtime, path, workDir, identity, mode);
}

/** Authenticated caller identity — the non-null shape `checkPathAccess` has already gated on. */
type SkillIdentity = NonNullable<ReturnType<Runtime["getCurrentIdentity"]>>;

/** Bundle-tier access: Layer 1 vendored skills are world-readable, never mutable. */
function bundleAccess(mode: AccessMode): PermissionDecision {
  if (mode === "read") return { allowed: true };
  return { allowed: false, reason: "Bundle (Layer 1) skills are vendored and not mutable" };
}

/** Org-tier access: any tenant member reads; only org admins/owners write. */
function orgAccess(mode: AccessMode, isOrgAdmin: boolean): PermissionDecision {
  if (mode === "read") return { allowed: true };
  return isOrgAdmin
    ? { allowed: true }
    : { allowed: false, reason: "Org-scope writes require org admin or owner" };
}

/** User-tier access: read+write only for the owning user named by the path (no org-admin override). */
function userScopeAccess(
  path: string,
  workDir: string,
  identity: SkillIdentity,
): PermissionDecision {
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

/**
 * Workspace-tier access: read+write require membership in the workspace named
 * by the path; write additionally requires the shared admin-role gate.
 */
async function workspaceScopeAccess(
  runtime: Runtime,
  path: string,
  workDir: string,
  identity: SkillIdentity,
  mode: AccessMode,
): Promise<PermissionDecision> {
  const pathWsId = extractWsIdFromPath(path, workDir);
  if (!pathWsId) {
    return { allowed: false, reason: "Could not derive workspace id from path" };
  }
  const ws = await runtime.getWorkspaceStore().get(pathWsId);
  if (!ws) return { allowed: false, reason: `Workspace "${pathWsId}" not found` };

  if (mode === "write") {
    // Workspace-scope write policy lives in the shared helper
    // (`canWriteWorkspaceScoped`): strict membership + admin role, no
    // org-admin override. All four workspace-write gates share it.
    const decision = canWriteWorkspaceScoped(identity, ws);
    return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
  }

  // Read: membership only (any role). Reads are deliberately NOT routed
  // through the write helper — a non-admin member may still read.
  const member = ws.members.find((m) => m.userId === identity.id);
  if (!member) {
    return {
      allowed: false,
      reason: `Not a member of workspace "${pathWsId}"`,
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
// Early path-traversal guard (runs before the target path is built + the
// permission check). Uses the canonical pattern so it's consistent with the
// schema's `validateSkill` — one source of truth, not a looser superset.
const VALID_NAME_RE = new RegExp(SKILL_NAME_PATTERN);
function assertValidName(name: string): void {
  if (!VALID_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}" — lowercase letters, digits, and single hyphens only (no leading/trailing/consecutive hyphen)`,
    );
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
    log.error("[skills] reloadSkills failed after mutation", {
      error: err instanceof Error ? err.message : String(err),
    });
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

/**
 * Assemble the on-write manifest for a create from the flat LLM-facing input,
 * defaulting the optional fields and stamping provenance (never author-supplied).
 */
function buildCreateManifest(
  manifest: SkillsCreateInput["manifest"],
  ctx: ReturnType<typeof getRequestContext>,
  createdBy: string | undefined,
  now: string,
): SkillManifest {
  const { name } = manifest;
  return {
    name,
    description: manifest.description,
    loadingStrategy: manifest.loadingStrategy ?? "dynamic",
    priority: manifest.priority ?? 50,
    status: manifest.status ?? "active",
    ...(manifest.toolAffinity && manifest.toolAffinity.length > 0
      ? { toolAffinity: manifest.toolAffinity }
      : {}),
    ...(manifest.triggers && manifest.triggers.length > 0 ? { triggers: manifest.triggers } : {}),
    ...(manifest.allowedTools && manifest.allowedTools.length > 0
      ? { allowedTools: manifest.allowedTools }
      : {}),
    provenance: {
      origin: ctx?.conversationId ? "chat" : "admin",
      ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
      ...(createdBy ? { createdBy } : {}),
      createdAt: now,
      updatedAt: now,
    },
  };
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

  // Build the runtime manifest from the flat LLM-facing input and stamp
  // provenance (never author-supplied — see schema). The writer maps this to
  // the nested on-disk `metadata.nimblebrain.*` shape.
  const ctx = getRequestContext();
  const createdBy = runtime.getCurrentIdentity()?.id;
  const now = new Date().toISOString();
  const fullManifest = buildCreateManifest(manifest, ctx, createdBy, now);

  // A `dynamic` skill with neither tool-affinity nor triggers is catalog-only:
  // it won't auto-load until the catalog ships (P3). We honor that rather than
  // silently bumping it to `always` — the author can add a trigger/tool-affinity,
  // or set `loading-strategy: always`, to make it load now.
  const mechanism = resolveLoadingMechanism(fullManifest);

  const validation = validateSkill(name, fullManifest, body);
  if (!validation.valid) {
    return errorResult(new Error(`Validation failed — ${validation.errors.join("; ")}`));
  }

  // The writer canonically validates before touching disk and throws if the
  // manifest wouldn't load — surface that as a clean tool error, no file left
  // behind. (validateSkill above already covered name/priority/override; this
  // catches the on-disk schema shape, e.g. an empty description.)
  try {
    writeSkill(dir, name, fullManifest, body);
  } catch (err) {
    return errorResult(err instanceof Error ? err : new Error(String(err)));
  }
  await reloadBootSkills(runtime);
  eventSink.emit({
    type: "skill.created",
    data: { id: target, name, scope },
  });

  const loadsNote =
    mechanism === "none"
      ? "catalog-only — won't auto-load yet; add a trigger or tool-affinity, or set loading-strategy: always"
      : mechanism;
  return {
    content: textContent(`Created ${scope} skill "${name}" → ${target} (loads: ${loadsNote})`),
    structuredContent: {
      id: target,
      name,
      scope,
      loadingStrategy: fullManifest.loadingStrategy,
    },
    isError: false,
  };
}

/**
 * Build a `Partial<SkillManifest>` from an update patch, keeping only the
 * fields the caller actually provided. `name` in the patch is ignored since
 * it's derived from the path (renaming is a separate operation). Metadata
 * sub-fields (keywords, triggers) are required arrays in the domain type but
 * optional in the LLM-facing schema, so we default-to-empty when they're
 * omitted — same boundary normalization as createSkill.
 */
function buildUpdatePatch(
  patch: SkillsUpdateInput["manifest"],
): Partial<SkillManifest> | undefined {
  if (!patch) return undefined;
  return {
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.loadingStrategy !== undefined ? { loadingStrategy: patch.loadingStrategy } : {}),
    ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    ...(patch.toolAffinity !== undefined ? { toolAffinity: patch.toolAffinity } : {}),
    ...(patch.triggers !== undefined ? { triggers: patch.triggers } : {}),
    ...(patch.allowedTools !== undefined ? { allowedTools: patch.allowedTools } : {}),
  };
}

// Input shape for `skills__update`. `manifest` is a partial of the
// create-shape — every field optional. Derived from the TypeBox schema
// in `./schemas/skills.ts`; the validator has already enforced shape.
/**
 * Refuse a body whose intent isn't stated. Defaulting either way is a silent
 * data hazard: `replace` destroys the rest of the skill when the caller meant
 * to add a rule (the incident this guard exists for), and `append` duplicates
 * the whole body when the caller sent a full rewrite. An error costs one
 * retry; both defaults cost content.
 */
function bodyModeError(body: string | undefined, bodyMode: unknown): ToolResult | null {
  if (body === undefined) return null;
  if (bodyMode === "append" || bodyMode === "replace") return null;
  return errorResult(
    new Error(
      "`body_mode` is required when `body` is given: " +
        '"append" to add this text to the skill, "replace" to overwrite the whole body. ' +
        "Use `append` when adding a rule — `replace` discards everything not in `body`.",
    ),
  );
}

/**
 * Refuse a path that points into `_versions/` rather than at a live skill.
 * Mutating a snapshot would snapshot a snapshot, and the loader skips that
 * subtree, so the result would be unreachable by every reader.
 */
function snapshotPathError(id: string): ToolResult | null {
  if (!isSnapshotPath(id)) return null;
  return errorResult(
    new Error(
      `"${id}" is a stored snapshot, not a live skill. Pass the live path and use ` +
        "`version` (skills__read) or skills__restore to work with history.",
    ),
  );
}

async function updateSkillHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
  authoringGuidePath: string,
  /**
   * Let this call write `manifest.status`. ONLY `set_status` passes it — that
   * tool is internal, so the door stays shut to the model. Without the flag a
   * `status` in the patch is refused rather than dropped: the schema no longer
   * declares the field, but the validator lets unknown keys through, so
   * ignoring it would report a successful disable that never happened.
   */
  opts: { allowStatus?: boolean } = {},
): Promise<ToolResult> {
  const { id, manifest: patch, body, body_mode: bodyMode } = input as unknown as SkillsUpdateInput;

  // Same gate the history/restore pair runs: scope, existence-before-permission,
  // write authority, and the symlink-boundary check that stops a link from
  // making `snapshotSkillVersion`'s copy read outside the tier.
  const gate = await gateSkillPath(runtime, id ?? "", authoringGuidePath, "write");
  if ("error" in gate) return gate.error;
  const scope = gate.scope;

  const dir = dirname(id);
  const name = (id.split("/").pop() ?? "").replace(/\.md$/, "");
  if (!name) return errorResult(new Error(`Cannot derive skill name from path "${id}"`));

  // Checked HERE, after the gate and immediately before the first destructive
  // act. Validating it earlier would answer "body_mode is required" to a caller
  // who is not allowed to write at all — a fix that gets them nowhere, hiding
  // the denial that actually applies.
  const modeError = bodyModeError(body, bodyMode);
  if (modeError) return modeError;

  snapshotSkillVersion(id);

  if (!opts.allowStatus && (patch as { status?: unknown } | undefined)?.status !== undefined) {
    return errorResult(
      new Error(
        "`manifest.status` is not editable here. Turning a skill off durably affects every " +
          "conversation in every workspace, so the user does it in Skills settings. To stop " +
          "using a skill for this conversation, call `skills__deactivate`.",
      ),
    );
  }
  // `buildUpdatePatch` drops `status` by construction, so the only way it
  // reaches the writer is this explicit re-add on the allowed path.
  const status = (patch as { status?: "active" | "disabled" } | undefined)?.status;
  const partial = {
    ...buildUpdatePatch(patch),
    ...(opts.allowStatus && status !== undefined ? { status } : {}),
  };
  // Merged result is canonically validated by the writer before write; a patch
  // that would make the skill unloadable fails cleanly, leaving the file as-is.
  try {
    updateSkill(dir, name, partial, body, bodyMode ?? "replace");
  } catch (err) {
    return errorResult(err instanceof Error ? err : new Error(String(err)));
  }
  await reloadBootSkills(runtime);

  eventSink.emit({ type: "skill.updated", data: { id, name, scope } });
  return {
    content: textContent(`Updated ${scope} skill "${name}"`),
    structuredContent: { id, name, scope },
    isError: false,
  };
}

/**
 * Shared gate for the history/restore pair: resolve scope, prove the file
 * exists, check permission, and refuse a symlink that escapes the tier.
 * Identical to the front half of `updateSkillHandler` — snapshots are the
 * skill's own content, so reaching them must cost exactly what reaching the
 * live file costs.
 */
async function gateSkillPath(
  runtime: Runtime,
  id: string,
  authoringGuidePath: string,
  access: "read" | "write",
): Promise<{ scope: WritableScope } | { error: ToolResult }> {
  if (!id) return { error: errorResult(new Error("`id` is required")) };
  const snapErr = snapshotPathError(id);
  if (snapErr) return { error: snapErr };
  if (id.startsWith(SKILL_URI_PREFIX)) return { error: bundleNotMutable() };
  const scope = scopeOfPath(runtime, id, authoringGuidePath);
  if (scope === "bundle") return { error: bundleNotMutable() };
  if (!scope) return { error: errorResult(new Error(unrecognizedIdMessage(id))) };
  if (!existsSync(id)) {
    return {
      error: errorResult(
        new Error(
          `Skill not found at "${id}". The file may have been moved or deleted — ` +
            `call skills__list to get current paths.`,
        ),
      ),
    };
  }
  const permission = await checkPathAccess(runtime, id, scope, access);
  if (!permission.allowed) {
    return {
      error: permissionDenied(permission.reason ?? "Permission denied", {
        path: id,
        scope,
        role: currentRoleHint(runtime, scope),
      }),
    };
  }
  try {
    assertSymlinkBoundaryOrThrow(runtime, id, scope);
  } catch (err) {
    return { error: errorResult(err) };
  }
  return { scope };
}

async function historySkillHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  authoringGuidePath: string,
): Promise<ToolResult> {
  const { id } = input as { id?: string };
  const gate = await gateSkillPath(runtime, id ?? "", authoringGuidePath, "read");
  if ("error" in gate) return gate.error;

  const versions = listSkillVersions(id as string);
  const summary = versions.length
    ? `${versions.length} saved version(s) of "${id}":\n` +
      versions.map((v) => `  ${v.version}  (${v.savedAt}, ${v.bytes} bytes)`).join("\n")
    : `No saved versions of "${id}" yet — snapshots start at the first update or delete.`;
  return {
    content: textContent(summary),
    structuredContent: { id, versions },
    isError: false,
  };
}

async function restoreSkillHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  eventSink: EventSink,
  authoringGuidePath: string,
): Promise<ToolResult> {
  const { id, version } = input as { id?: string; version?: string };
  if (!version) return errorResult(new Error("`version` is required"));
  const gate = await gateSkillPath(runtime, id ?? "", authoringGuidePath, "write");
  if ("error" in gate) return gate.error;
  const path = id as string;

  const raw = readSkillVersionRaw(path, version);
  if (raw === null) {
    return errorResult(
      new Error(
        `No version "${version}" for "${path}". Call skills__history to list available versions.`,
      ),
    );
  }
  const parsed = parseSkillContent(raw, path, { cap: false });
  if (!parsed) {
    return errorResult(new Error(`Snapshot "${version}" of "${path}" could not be parsed.`));
  }

  // Snapshot the CURRENT file before overwriting it, so restoring to the
  // wrong version is itself recoverable — the property whose absence made
  // the original loss permanent.
  snapshotSkillVersion(path);

  const dir = dirname(path);
  const name = (path.split("/").pop() ?? "").replace(/\.md$/, "");
  try {
    writeSkill(dir, name, parsed.manifest, parsed.body);
  } catch (err) {
    return errorResult(err instanceof Error ? err : new Error(String(err)));
  }
  await reloadBootSkills(runtime);

  eventSink.emit({ type: "skill.updated", data: { id: path, name, scope: gate.scope } });
  return {
    content: textContent(`Restored ${gate.scope} skill "${name}" from version ${version}`),
    structuredContent: { id: path, name, scope: gate.scope, version },
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

  // The same gate update / history / restore run. Delete is the last
  // destructive path that carried its own copy, which is why it was also the
  // last one that would accept a `_versions/` path — deleting a snapshot and
  // leaving a nested `_versions/_versions/` no reader can see.
  const gate = await gateSkillPath(runtime, id ?? "", authoringGuidePath, "write");
  if ("error" in gate) return gate.error;
  const scope = gate.scope;

  const dir = dirname(id as string);
  const name = ((id as string).split("/").pop() ?? "").replace(/\.md$/, "");
  if (!name) return errorResult(new Error(`Cannot derive skill name from path "${id}"`));

  snapshotSkillVersion(id as string);
  deleteSkill(dir, name);
  await reloadBootSkills(runtime);

  eventSink.emit({ type: "skill.deleted", data: { id, name, scope } });
  return {
    content: textContent(`Deleted ${scope} skill "${name}" (snapshotted to _versions/)`),
    structuredContent: { id, name, scope },
    isError: false,
  };
}

/**
 * Mute or un-mute a skill FOR THE CURRENT CONVERSATION.
 *
 * This used to write `status:` to the skill file, which is shared by every
 * conversation that loads it — for a user-scope skill, across every workspace
 * that user touches. So one chat's "not right now" silently reconfigured all
 * the others, with no signal to any of them, and an operator ended up policing
 * skill state by hand.
 *
 * The two intents behind that one write are genuinely different, and only one
 * of them is the agent's: "don't use this for the task at hand" is per
 * conversation, while "retire this skill" is a durable decision a human makes
 * in settings, where they can see the blast radius. Turning a skill off
 * permanently is no longer reachable from here at all.
 *
 * Resolution is by NAME, not path: a mute is conversation state, so it never
 * touches the file and needs none of the path gates `update` runs. The name is
 * validated against what this workspace can actually activate, so a typo is an
 * error rather than a silent no-op the model reads as success.
 */
async function setStatusHandler(
  runtime: Runtime,
  input: Record<string, unknown>,
  status: "active" | "disabled",
): Promise<ToolResult> {
  const name = typeof input.id === "string" ? input.id : "";
  if (!name) return errorResult(new Error("`id` is required — the skill name from `skills__list`"));

  const { wsId, userId } = resolveCallContext(runtime);
  // A mute takes effect through a `_meta` marker the ENGINE turns into a
  // conversation event. Called outside a run — over REST, say — the marker is
  // dropped and the call would report success while changing nothing. Refuse
  // instead: a steering control that silently does nothing is how the bug this
  // replaces stayed invisible for so long.
  if (!wsId || !getRequestContext()?.conversationId) {
    return errorResult(
      new Error(
        "Muting a skill is conversation state, so it only works inside a chat. " +
          "To change a skill's stored status, use Skills settings.",
      ),
    );
  }
  // The mutable set is everything that can COMPOSE into this conversation, not
  // just what can be activated on demand. `listActivatableSkills` is the
  // catalog — `dynamic` skills plus bundle/connector guidance — and excludes
  // `always` skills by construction, since you never activate one. Those are
  // exactly the skills a user most wants muted (the always-on voice skill is
  // the motivating case), so validating against the catalog alone rejected the
  // main use with a confusing "unknown skill".
  // The same union composition filters — see `Runtime.suppressibleSkillNames`.
  // Anything narrower rejects a name the model legitimately read from the
  // catalog; anything wider accepts one the filter will not act on.
  const known = await runtime.suppressibleSkillNames(wsId, userId);
  // A path still reaches here from habit (`update`/`delete` take one), so fall
  // back to its basename. A bundle-published skill has no path, which is why
  // the schema now asks for a name rather than relying on this.
  const resolved = known.has(name) ? name : (name.split("/").pop() ?? name).replace(/\.md$/, "");
  if (!known.has(resolved)) {
    return errorResult(
      new Error(
        `Unknown skill "${name}". Valid names in this workspace: ${[...known].sort().join(", ") || "(none)"}.`,
      ),
    );
  }

  const suppressed = status === "disabled";
  return {
    content: textContent(
      suppressed
        ? `Muted "${resolved}" for this conversation. It stops composing from the next turn. ` +
            `Other conversations and workspaces are unaffected; to turn it off everywhere, the user ` +
            `does that in Skills settings.`
        : `Un-muted "${resolved}" for this conversation. It composes again from the next turn.`,
    ),
    structuredContent: { name: resolved, suppressed, scope: "conversation" },
    _meta: { [SKILL_SUPPRESSION_META_KEY]: { skillName: resolved, suppressed } },
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
