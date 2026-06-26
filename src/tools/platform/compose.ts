/**
 * `compose` platform source — exposes `compose__effective_context`.
 *
 * Single-call answer to "what's in the system prompt for conversation X,
 * with provenance per layer." Replaces the manual jsonl-grep workflow
 * for prod debugging.
 *
 * Two modes:
 *   - **Live (default).** Re-gathers the same inputs `runtime.chat()` uses
 *     and runs `composeSystemPromptTraced` to produce the full per-layer
 *     breakdown for the current state. Honest answer to "what would
 *     compose right now if a turn started in this conversation."
 *   - **Historical (`run_id` set).** Reads `context.assembled` and
 *     `skills.loaded` events for the given run from the conv jsonl. For
 *     each Layer 3 skill, re-reads the current on-disk body, computes its
 *     SHA-256, and compares to the recorded `contentHash`. Hash matches
 *     mean the recorded body is recoverable verbatim; mismatches mean
 *     the skill was edited since the run, and the tool surfaces a
 *     warning with the path to the most recent `_versions/` snapshot
 *     when one matches the recorded hash.
 *
 * Historical mode v1 covers Layer 3 skills only — non-L3 layers
 * (identity, prefs, overlays, apps, focused-app, app-state) aren't
 * recorded in `context.assembled` events with enough detail to
 * reconstruct, and snapshotting full bodies into events was rejected as
 * too expensive (10-100× event size). The tool's response sets
 * `mode: "historical"` and includes a `non_l3_layers_omitted` warning
 * directing the caller at live mode for the rest.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isToolVisibleToRole } from "../../config/features.ts";
import {
  CONVERSATION_ID_RE,
  type ContextAssembledEvent,
  type ConversationEvent,
  type SkillsLoadedEvent,
} from "../../conversation/types.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import {
  type ComposedPrompt,
  composeSystemPromptTraced,
  deriveBundleFromSkillPath,
  type Layer3SkillEntry,
  type TracedLayer,
  type WorkspaceContext,
} from "../../prompt/compose.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import { makeIdentitySkill, type Runtime } from "../../runtime/runtime.ts";
import { hashSkillBody } from "../../runtime/skills-loaded-payload.ts";
import { parseSkillContent } from "../../skills/loader.ts";
import { partitionSkillsByRole, selectLayer3Skills } from "../../skills/select.ts";
import type { InProcessTool } from "../in-process-app.ts";
import { defineInProcessApp } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { surfaceTools } from "../surfacing.ts";
import { ComposeEffectiveContextInput } from "./schemas/compose.ts";

const COMPOSE_SOURCE_NAME = "compose";

const COMPOSE_DESCRIPTION =
  "Return the composed system prompt with provenance per layer (identity, core " +
  "skills, user context, overlays, layer-3 skills, apps, etc). Defaults to live " +
  "mode, which composes against the **calling request's workspace** — `convId` " +
  "is echoed as a label and does NOT select the workspace. To inspect a " +
  "different workspace, call from within that workspace's context. " +
  "Pass `run_id` for historical mode — reads the recorded `skills.loaded` event " +
  "for that run from the calling workspace's conv jsonl and verifies each " +
  "layer-3 skill's `contentHash` against its current source, flagging drift. " +
  "Pass `bundle` to filter the response to one bundle's contributions (apps " +
  "section + layer-3 skills under the bundle's affined directory). Read-only. " +
  "Use this to answer 'what's in the agent's prompt right now' or 'what was " +
  "in the prompt for run X'.";

interface ComposeArgs {
  conversation_id?: string;
  run_id?: string;
  bundle?: string;
}

/** Exported for unit testing. */
export interface ComposeResponse {
  mode: "live" | "historical";
  conversationId: string;
  runId?: string;
  totalTokens: number;
  text: string;
  layers: TracedLayer[];
  warnings: string[];
}

/**
 * Build the platform source. One tool, one resource is implied (the source
 * itself is queryable via tools/list); no resources are published — the
 * tool returns the composition synthetically per call.
 */
export function createComposeSource(runtime: Runtime, eventSink: EventSink): McpSource {
  const tools: InProcessTool[] = [
    {
      name: "effective_context",
      description: COMPOSE_DESCRIPTION,
      inputSchema: ComposeEffectiveContextInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        const args = input as ComposeArgs;
        try {
          // Resolve conv id — explicit arg wins; fall back to the current
          // conversation in scope (set by `runtime.chat()` via RequestContext).
          // Without either, fail explicitly: the tool can't compose for
          // "no conversation in particular."
          const argConvId =
            typeof args.conversation_id === "string" && args.conversation_id.length > 0
              ? args.conversation_id
              : undefined;
          const ctxConvId = getRequestContext()?.conversationId;
          const convId = argConvId ?? ctxConvId;
          if (!convId) {
            return errorResult(
              "conversation_id is required when called outside a chat — no current " +
                "conversation is in scope. Pass conversation_id explicitly.",
            );
          }
          // Validate the id shape before any filesystem access. Without this,
          // a malformed id (`../foo`, etc.) would reach `existsSync` first and
          // probe an arbitrary path — boolean info disclosure. The downstream
          // `validateConversationId` already throws inside the store, but
          // gating up front shifts the trust boundary to where it belongs.
          if (!CONVERSATION_ID_RE.test(convId)) {
            return errorResult(
              `conversation_id "${convId}" is not a valid conversation id (expected conv_<16 hex chars>).`,
            );
          }

          const response: ComposeResponse = args.run_id
            ? await composeHistorical(runtime, convId, args.run_id)
            : await composeLive(runtime, convId);

          // Bundle filter applied last so the structural contract (mode,
          // conversationId, etc.) doesn't depend on filter shape.
          if (args.bundle) {
            applyBundleFilter(response, args.bundle);
          }

          return {
            content: textContent(formatTextSummary(response)),
            structuredContent: response as unknown as Record<string, unknown>,
            isError: false,
          };
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];

  return defineInProcessApp(
    {
      name: COMPOSE_SOURCE_NAME,
      version: "1.0.0",
      tools,
    },
    eventSink,
  );
}

// ── live mode ────────────────────────────────────────────────────────────

/**
 * Live mode: re-gather the same inputs `runtime.chat()` uses and call
 * `composeSystemPromptTraced` to produce the full per-layer breakdown for
 * the current state. The composition is scoped to the **calling
 * request's workspace** (`runtime.requireWorkspaceId()`), not to the
 * `convId`'s workspace — `convId` is a label echoed back in the
 * response, NOT a workspace selector. To inspect a different workspace,
 * the caller must invoke from within that workspace's request context.
 *
 * Inputs gathered (mirrors `runtime.chat()` for everything not request-
 * scoped):
 *   - `contextSkills` = global `runtime.getContextSkills()` PLUS the
 *     workspace identity override (`workspace.identity` synthesized into
 *     a priority-1 core skill). The override is the workspace-scoping
 *     piece — without it the trace would lie for any workspace using a
 *     custom identity.
 *   - `apps` = `runtime.buildAppsList(wsId)` — workspace-scoped, includes
 *     each bundle's `app://instructions` overlay.
 *   - `overlays` = `runtime.readPromptOverlays(wsId)` — org + workspace
 *     instruction overlays.
 *   - `layer3Skills` = `loadConversationSkills` ∩ `selectLayer3Skills`
 *     against the role-filtered active tool set.
 *   - `prefs` = identity preferences.
 *
 * Skipped vs. `runtime.chat()` (request-scoped, no signal in a debug
 * call):
 *   - matched skill (legacy SkillMatcher path) — needs a user message.
 *   - focused-app section / app-state — only present when a chat is
 *     running against an app context.
 *   - participants — shared-conv state.
 */
async function composeLive(runtime: Runtime, convId: string): Promise<ComposeResponse> {
  const wsId = runtime.requireWorkspaceId();
  const identity = runtime.getCurrentIdentity();

  // Gather workspace metadata + the workspace identity override (per-
  // workspace `workspace.identity` synthesized into a priority-1 context
  // skill, exactly like `runtime.chat()` does at line ~708). Without this
  // append, the trace would silently report `DEFAULT_IDENTITY` for any
  // workspace operating under a custom identity — defeating the headline
  // purpose of the tool.
  const ws = await runtime.getWorkspaceStore().get(wsId);
  const workspaceContext: WorkspaceContext = ws ? { id: ws.id, name: ws.name } : { id: wsId };
  const identityOverride = ws?.identity ? makeIdentitySkill(ws.identity) : null;
  // Partition the conversation pool by ROLE, exactly as `runtime.chat()` does:
  // `context` (every tier, active only) → Layer 0/1; `capability` → Layer 3.
  // This trace must equal what chat composes — including workspace/user-tier
  // context skills, which the boot-only `activeContextSkills()` would miss, and
  // it filters disabled context skills the same way.
  const userId = identity?.id ?? null;
  const { context: poolContext, capability: poolCapability } = partitionSkillsByRole(
    runtime.loadConversationSkills(wsId, userId),
  );
  const requestContextSkills = identityOverride ? [...poolContext, identityOverride] : poolContext;

  // Gather inputs in parallel where possible.
  const [apps, overlays] = await Promise.all([
    runtime.buildAppsList(wsId),
    runtime.readPromptOverlays(wsId),
  ]);

  // Replicate `runtime.chat()`'s tool-set construction so the trace
  // matches reality:
  //   1. Read the workspace registry's full tool list.
  //   2. Filter by `isToolVisibleToRole(toolName, identity?.orgRole)` —
  //      runtime.chat skips tools the caller's role can't see, and L3
  //      tool-affinity skills match against that filtered set.
  //   3. Run `surfaceTools` to split the result into `direct` (in the
  //      LLM's tool list) and `proxied` (discoverable via `nb__search`).
  //      The apps section's prompt body changes based on
  //      `proxied.length > 0`, so the trace MUST compute this correctly
  //      — the previous hard-coded `false` understated the prompt for
  //      Tier 2/3 workspaces (more than DEFAULT_MAX_DIRECT_TOOLS tools).
  const registry = runtime.getRegistryForWorkspace(wsId);
  const allTools = (await registry.availableTools()).filter((t) =>
    isToolVisibleToRole(t.name, identity?.orgRole),
  );
  const { direct: directTools, proxied } = surfaceTools(allTools, null, {});
  const activeToolNames = directTools.map((t) => t.name);

  const selectedLayer3 = selectLayer3Skills({
    skills: poolCapability,
    activeTools: activeToolNames,
  });
  const layer3Entries: Layer3SkillEntry[] = selectedLayer3.map((s) => ({
    name: s.skill.manifest.name,
    body: s.skill.body,
    scope: s.skill.manifest.scope ?? "org",
    ...(s.skill.sourcePath ? { sourcePath: s.skill.sourcePath } : {}),
    loadedBy: s.loadedBy,
    reason: s.reason,
  }));

  const composed: ComposedPrompt = composeSystemPromptTraced(
    requestContextSkills,
    null, // matched skill — request-scoped, skipped in live mode
    apps,
    undefined, // focused app — request-scoped
    undefined, // app state — request-scoped
    identity
      ? {
          displayName: identity.displayName ?? "",
          timezone: identity.preferences?.timezone ?? "",
          locale: identity.preferences?.locale ?? "en-US",
        }
      : undefined,
    proxied.length > 0,
    workspaceContext,
    overlays,
    layer3Entries,
  );

  return {
    mode: "live",
    conversationId: convId,
    totalTokens: composed.totalTokens,
    text: composed.text,
    layers: composed.layers,
    warnings: [],
  };
}

// ── historical mode ──────────────────────────────────────────────────────

/**
 * Historical mode: read the run's `skills.loaded` event from the conv
 * jsonl, re-read each Layer 3 skill from disk, and verify the recorded
 * `contentHash` against the current source.
 *
 * Returns only the layer-3 skill rows + a notice that non-L3 layers
 * aren't reconstructible from current telemetry. For the full prompt as
 * it would compose now, the caller drops `run_id` (live mode).
 */
async function composeHistorical(
  runtime: Runtime,
  convId: string,
  runId: string,
): Promise<ComposeResponse> {
  const events = await readConvEvents(runtime, convId);
  if (events === null) {
    throw new Error(`Conversation not found: ${convId}`);
  }

  const skillsLoaded = events.find(
    (e): e is SkillsLoadedEvent => e.type === "skills.loaded" && e.runId === runId,
  );
  // Read for `totalTokens` only — the run's full prompt token count is the
  // honest answer for historical mode (vs. just the L3 sum from
  // skillsLoaded). The event's other fields (per-source breakdown,
  // exclusions) are recorded but intentionally not surfaced here; the
  // L3-only view is the design contract for historical mode v1, and
  // surfacing the rest would imply we can reconstruct the layers we can't.
  // A future "rich historical mode" PR could expand this.
  const contextAssembled = events.find(
    (e): e is ContextAssembledEvent => e.type === "context.assembled" && e.runId === runId,
  );

  if (!skillsLoaded && !contextAssembled) {
    throw new Error(
      `No \`skills.loaded\` or \`context.assembled\` events found for run ${runId} in conversation ${convId}. ` +
        `The run may have started before telemetry was emitted, or the run id is wrong.`,
    );
  }

  const warnings: string[] = [
    "non_l3_layers_omitted: historical mode shows Layer 3 skills only. " +
      "Identity, user prefs, workspace context, overlays, apps, focused-app, and " +
      "app-state are not recorded in events with enough detail to reconstruct. " +
      "Drop `run_id` for live mode to see the full current composition.",
  ];

  const layers: TracedLayer[] = [];
  let totalTokens = 0;

  if (skillsLoaded) {
    const subItems: TracedLayer["subItems"] = [];
    const bodyRows: string[] = [`## Skills (historical, run ${runId})`, ""];

    for (const entry of skillsLoaded.skills) {
      const audit = auditL3Skill(entry);
      if (audit.warning) warnings.push(audit.warning);
      subItems.push({
        kind: "layer3_skill",
        id: entry.id,
        source: audit.body !== null ? entry.id : `${entry.id} (body unavailable)`,
        ...(audit.bundle ? { bundle: audit.bundle } : {}),
        metadata: {
          scope: entry.scope,
          loadedBy: entry.loadedBy,
          reason: entry.reason,
          tokens: entry.tokens,
          recordedHash: entry.contentHash,
          hashStatus: audit.hashStatus,
          ...(audit.snapshotPath ? { snapshotPath: audit.snapshotPath } : {}),
        },
      });
      if (audit.body !== null) {
        bodyRows.push(`### ${entry.id}`);
        bodyRows.push(`_scope: ${entry.scope}; loaded: ${entry.loadedBy} — ${entry.reason}_`);
        bodyRows.push(`_hash: ${audit.hashStatus}_`);
        bodyRows.push("");
        bodyRows.push(`<layer3-skill>\n${audit.body}\n</layer3-skill>`);
        bodyRows.push("");
      }
      totalTokens += entry.tokens;
    }

    layers.push({
      kind: "layer3_skills",
      segment: "stable",
      id: "nb:layer3-skills",
      source: `layer 3 skills as of run ${runId}`,
      text: bodyRows.join("\n"),
      tokens: skillsLoaded.totalTokens,
      subItems,
    });
  }

  // If context.assembled gave us a more accurate total-token count for the
  // run, prefer it (skillsLoaded.totalTokens is just the L3 sum).
  if (contextAssembled?.totalTokens) {
    totalTokens = contextAssembled.totalTokens;
  }

  // Prefix the joined text with a banner so anyone reading `text` directly
  // (instead of the structured `layers` array) sees this is a partial
  // reconstruction, not the full prompt as recorded. Live mode's `text`
  // IS the full prompt; historical mode's `text` is layer-3-only by design,
  // and a programmatic caller treating it as "the prompt" without reading
  // `warnings[]` would silently get an L3 slice.
  const HISTORICAL_BANNER =
    "[historical mode — layer 3 only. Identity, prefs, overlays, apps, focused-app, " +
    "and app-state are not reconstructed from events. Use live mode for the full " +
    "current composition; see warnings[] for details.]";
  const composedText =
    layers.length > 0
      ? `${HISTORICAL_BANNER}\n\n---\n\n${layers.map((l) => l.text).join("\n\n---\n\n")}`
      : HISTORICAL_BANNER;

  return {
    mode: "historical",
    conversationId: convId,
    runId,
    totalTokens,
    text: composedText,
    layers,
    warnings,
  };
}

interface L3SkillAudit {
  /** "match" — current body matches recorded hash; body is the current on-disk text.
   *  "drift" — current body's hash differs from recorded; body is the current text.
   *  "recovered" — current body differs but a `_versions/` snapshot matches; body is the snapshot text.
   *  "missing" — file no longer exists on disk; body is null. */
  hashStatus: "match" | "drift" | "recovered" | "missing";
  body: string | null;
  bundle?: string;
  snapshotPath?: string;
  warning?: string;
}

/**
 * Verify a single Layer 3 skill's recorded hash against its current source,
 * with `_versions/` recovery on drift. Pure read-only filesystem access.
 */
function auditL3Skill(entry: SkillsLoadedEvent["skills"][number]): L3SkillAudit {
  const path = entry.id;
  // `skill-in-memory:<name>` ids are synthesized for skills without a
  // sourcePath (e.g. workspace identity overrides). Nothing to verify.
  // POSIX-only check — the platform's deployed targets (Linux, macOS) put
  // skill files under absolute POSIX paths. A future Windows port would
  // need to broaden this (`path.isAbsolute(path)`) since drive-letter
  // paths don't begin with `/`.
  if (!path.startsWith("/")) {
    return {
      hashStatus: "missing",
      body: null,
      warning: `skill ${path}: in-memory skill (no sourcePath) — body not recoverable from disk`,
    };
  }
  if (!existsSync(path)) {
    return {
      hashStatus: "missing",
      body: null,
      warning: `skill ${path}: file no longer exists on disk`,
    };
  }
  const currentBody = bodyFromSkillFile(path);
  if (currentBody === null) {
    return {
      hashStatus: "missing",
      body: null,
      warning: `skill ${path}: file exists but failed to parse as a skill`,
    };
  }
  const currentHash = hashSkillBody(currentBody);
  const bundle = deriveBundleFromSkillPath(path);

  if (entry.contentHash === currentHash) {
    return { hashStatus: "match", body: currentBody, ...(bundle ? { bundle } : {}) };
  }

  // Drift detected. Try to find a `_versions/` snapshot whose body hashes
  // to the recorded value — if so, the operator's edit is recoverable.
  const snapshot = findMatchingSnapshot(path, entry.contentHash);
  if (snapshot) {
    return {
      hashStatus: "recovered",
      body: snapshot.body,
      snapshotPath: snapshot.path,
      ...(bundle ? { bundle } : {}),
      warning: `skill ${path}: edited since this run; recovered the loaded body from ${snapshot.path}`,
    };
  }

  return {
    hashStatus: "drift",
    body: currentBody,
    ...(bundle ? { bundle } : {}),
    warning: `skill ${path}: edited since this run, no matching snapshot in _versions/. Showing current body — content may differ from what actually loaded.`,
  };
}

/**
 * Read a skill file from disk and return its body (post-frontmatter,
 * trimmed) — the same bytes that go into `hashSkillBody` at emission time.
 * Routes through `parseSkillContent` so the audit and the emitter use
 * identical extraction logic; otherwise a stripping mismatch (e.g.
 * trailing newline kept on one side) shows up as a false `drift`.
 *
 * Returns `null` if parsing fails (malformed frontmatter, missing name,
 * etc.) — the audit reports this as `missing`.
 */
function bodyFromSkillFile(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf-8");
    // Cap to match the emission-time `contentHash`, NOT the stored body: Layer-3
    // bodies are hashed AFTER the prompt-load cap (skills-loaded-payload.ts), so
    // re-hashing the full body here would false-report drift on every skill over
    // the cap and snapshot recovery would never match.
    return parseSkillContent(raw, path, { cap: true })?.body ?? null;
  } catch {
    return null;
  }
}

/**
 * Walk `<dirname>/_versions/<filename>.<ts>.md` files looking for one
 * whose body hashes to `targetHash`. Returns the body + path on match,
 * `null` otherwise. Bounded I/O — reads at most each version file once
 * and stops on first match.
 */
function findMatchingSnapshot(
  livePath: string,
  targetHash: string,
): { body: string; path: string } | null {
  const dir = livePath.slice(0, livePath.lastIndexOf("/"));
  const filename = livePath.slice(dir.length + 1);
  const baseName = filename.replace(/\.md$/, "");
  const versionsDir = join(dir, "_versions");
  if (!existsSync(versionsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return null;
  }

  // The snapshot naming convention is `<baseName>.<utc-iso>.md`. Filter
  // to files belonging to this skill and walk newest-first (lexicographic
  // descending on the timestamp segment).
  const candidates = entries
    .filter((e) => e.startsWith(`${baseName}.`) && e.endsWith(".md"))
    .sort((a, b) => b.localeCompare(a));

  for (const entry of candidates) {
    const fullPath = join(versionsDir, entry);
    const body = bodyFromSkillFile(fullPath);
    if (body !== null && hashSkillBody(body) === targetHash) {
      return { body, path: fullPath };
    }
  }
  return null;
}

// ── conv-event reading ───────────────────────────────────────────────────

async function readConvEvents(
  runtime: Runtime,
  convId: string,
): Promise<ConversationEvent[] | null> {
  // Mirrors the helper in skills.ts. Inlined here rather than imported so
  // this source doesn't take a dep on a sibling tool's private API.
  //
  // Stage 1 single-owner: gate the read on ownership BEFORE touching
  // the event log. The conversation id is a tool input — any
  // authenticated caller could pass an arbitrary id; without this
  // check, `effective_context` would happily read peer conversations'
  // assembled-context / skills.loaded / llm.response events.
  const identity = runtime.getCurrentIdentity();
  if (!identity) return null;
  // One locator resolution: get the conversation's room store, then gate on
  // ownership via its access-checked `load` (null for both not-found and
  // foreign-owner, same shape as the "no store" branch).
  const store = await runtime.resolveConversationStore(convId);
  if (!store) return null;
  const owned = await store.load(convId, { userId: identity.id });
  if (!owned) return null;
  return store.readEvents(convId);
}

// ── bundle filter ────────────────────────────────────────────────────────

/**
 * Filter the response to one bundle's contributions in place. A layer is
 * kept if its top-level `bundle` matches OR if any of its `subItems`
 * carries the matching bundle; for sections with subItems, the subItems
 * array is also pared to just the matching ones.
 *
 * All three response fields are kept consistent with the filtered layers:
 * `layers`, `totalTokens` (re-summed), and `text` (re-joined from the
 * filtered layer texts). Earlier versions left `text` untouched, which
 * meant a caller using `r.totalTokens` to budget context would be misled
 * by an `r.text` carrying content from layers that aren't in
 * `r.layers` — a self-inconsistent response.
 *
 * Note that for sections like `apps` where `subItems` are pared, the
 * layer's `text` field still contains the section's full original
 * formatting (we don't re-run the apps-section formatter against just
 * the filtered apps). This is honest about scope: the tool surfaces the
 * filtered subItems for fine-grained inspection while keeping section
 * text intact for context. Consumers wanting per-bundle prompt text
 * should walk the subItems, not slice the section text.
 */
/** Exported for unit testing. */
export function applyBundleFilter(response: ComposeResponse, bundle: string): void {
  const filtered: TracedLayer[] = [];
  for (const layer of response.layers) {
    const ownBundleMatches = layer.bundle === bundle;
    const matchingSubs = layer.subItems?.filter((s) => s.bundle === bundle) ?? [];
    if (ownBundleMatches) {
      filtered.push(layer);
      continue;
    }
    if (matchingSubs.length > 0) {
      filtered.push({ ...layer, subItems: matchingSubs });
    }
  }
  response.layers = filtered;
  response.totalTokens = filtered.reduce((sum, l) => sum + l.tokens, 0);
  // Rejoin from the filtered layer texts so `text` reflects the same
  // subset as `layers` and `totalTokens`. In historical mode this drops
  // the leading banner — that's correct; the filter narrowed the view
  // and the banner described an unfiltered partial.
  response.text = filtered.map((l) => l.text).join("\n\n---\n\n");
}

// ── helpers ──────────────────────────────────────────────────────────────

function errorResult(message: string): ToolResult {
  return { content: textContent(message), isError: true };
}

/**
 * One-line summary for the textContent. The structuredContent carries the
 * full per-layer detail — text is just the human-readable hint that the
 * call succeeded and which mode it ran in.
 */
function formatTextSummary(response: ComposeResponse): string {
  const head =
    response.mode === "live"
      ? `Composed (live) for ${response.conversationId}: ${response.layers.length} layers, ${response.totalTokens} tokens`
      : `Composed (historical, run ${response.runId}) for ${response.conversationId}: ${response.layers.length} layer(s) reconstructed, ${response.totalTokens} tokens recorded`;
  if (response.warnings.length === 0) return head;
  return `${head}\n\nWarnings:\n${response.warnings.map((w) => `- ${w}`).join("\n")}`;
}
