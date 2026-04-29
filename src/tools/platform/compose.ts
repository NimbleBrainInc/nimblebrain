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
import type { ContextAssembledEvent, SkillsLoadedEvent } from "../../conversation/types.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import {
  type ComposedPrompt,
  composeSystemPromptTraced,
  type Layer3SkillEntry,
  type TracedLayer,
  type WorkspaceContext,
} from "../../prompt/compose.ts";
import { getRequestContext } from "../../runtime/request-context.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { hashSkillBody } from "../../runtime/skills-loaded-payload.ts";
import { parseSkillContent } from "../../skills/loader.ts";
import { selectLayer3Skills } from "../../skills/select.ts";
import type { InProcessTool } from "../in-process-app.ts";
import { defineInProcessApp } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";

const COMPOSE_SOURCE_NAME = "compose";

const COMPOSE_DESCRIPTION =
  "Return the composed system prompt for a conversation, with provenance per " +
  "layer (identity, core skills, user context, overlays, layer-3 skills, apps, " +
  "etc). Defaults to live mode (current state for the conversation's workspace). " +
  "Pass `run_id` for historical mode — reads the recorded `skills.loaded` event " +
  "for that run and verifies each layer-3 skill's `contentHash` against its " +
  "current source, flagging drift. Pass `bundle` to filter the response to one " +
  "bundle's contributions (the apps section row + any layer-3 skills in that " +
  "bundle's affined directory). Read-only. Use this to answer 'what's in the " +
  "agent's prompt right now' or 'what was in the prompt for run X'.";

interface ComposeArgs {
  conversation_id?: string;
  run_id?: string;
  bundle?: string;
}

interface ComposeResponse {
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
      inputSchema: {
        type: "object",
        properties: {
          conversation_id: {
            type: "string",
            description:
              "Conversation id whose prompt is being inspected. Optional inside " +
              "a chat — defaults to the current conversation.",
          },
          run_id: {
            type: "string",
            description:
              "Specific past run within the conversation. Triggers historical " +
              "mode (reads `context.assembled` + `skills.loaded` events; verifies " +
              "layer-3 skill content hashes). Default: live mode (current state).",
          },
          bundle: {
            type: "string",
            description:
              "Filter the response to one bundle's contributions (apps section " +
              "row + layer-3 skills under the bundle's affined directory).",
          },
        },
      },
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
 * the current state.
 *
 * Skipped vs. `runtime.chat()`:
 *   - matched skill (legacy SkillMatcher path) — needs a user message, not
 *     in scope for a "what's currently composed" query.
 *   - focused-app section / app-state — request-scoped, only present when
 *     a chat is running against an app context.
 *   - participants — request-scoped (shared-conv state).
 *
 * Everything else (core skills, user context, prefs, workspace context,
 * overlays, layer-3 skills, apps) is workspace-scoped and faithful.
 */
async function composeLive(runtime: Runtime, convId: string): Promise<ComposeResponse> {
  const wsId = runtime.requireWorkspaceId();
  const identity = runtime.getCurrentIdentity();

  // Gather workspace metadata for the workspace_context layer.
  const ws = await runtime.getWorkspaceStore().get(wsId);
  const workspaceContext: WorkspaceContext = ws ? { id: ws.id, name: ws.name } : { id: wsId };

  // Gather inputs in parallel where possible.
  const [apps, overlays] = await Promise.all([
    runtime.buildAppsList(wsId),
    runtime.readPromptOverlays(wsId),
  ]);

  // Layer 3 selection requires the workspace's currently-active tool set
  // (so `tool_affined` skills resolve correctly). Match `runtime.chat()`'s
  // pattern: read tools from the workspace registry.
  const registry = runtime.getRegistryForWorkspace(wsId);
  const tools = await registry.availableTools();
  const activeToolNames = tools.map((t) => t.name);

  const userId = identity?.id ?? null;
  const layer3Pool = runtime.loadConversationSkills(wsId, userId);
  const selectedLayer3 = selectLayer3Skills({
    skills: layer3Pool,
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
    runtime.getContextSkills(),
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
    false, // hasProxiedTools — informational; safe default in live mode
    undefined, // participants — request-scoped
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

  return {
    mode: "historical",
    conversationId: convId,
    runId,
    totalTokens,
    text: layers.map((l) => l.text).join("\n\n---\n\n"),
    layers,
    warnings,
  };
}

interface L3SkillAudit {
  /** "match" — current body matches recorded hash; body is the current on-disk text.
   *  "drift" — current body's hash differs from recorded; body is the current text.
   *  "recovered" — current body differs but a `_versions/` snapshot matches; body is the snapshot text.
   *  "missing" — file no longer exists on disk; body is null.
   *  "no-recorded-hash" — the event was written before contentHash was added; can't verify. */
  hashStatus: "match" | "drift" | "recovered" | "missing" | "no-recorded-hash";
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
  const bundle = deriveBundleFromPath(path);

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
    return parseSkillContent(raw, path)?.body ?? null;
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

/**
 * Same convention as `compose.ts::deriveBundleFromSkillPath` — duplicated
 * here so the historical-audit path doesn't need to import compose.ts's
 * private helper. A skill at `.../skills/bundles/<name>/x.md` is bundle-
 * affined; anything else is bundle-agnostic.
 */
function deriveBundleFromPath(sourcePath: string): string | undefined {
  const m = sourcePath.match(/\/skills\/bundles\/([^/]+)\//);
  return m?.[1];
}

// ── conv-event reading ───────────────────────────────────────────────────

async function readConvEvents(
  runtime: Runtime,
  convId: string,
): Promise<import("../../conversation/types.ts").ConversationEvent[] | null> {
  // Mirrors the helper in skills.ts. Inlined here rather than imported so
  // this source doesn't take a dep on a sibling tool's private API.
  const { EventSourcedConversationStore } = await import(
    "../../conversation/event-sourced-store.ts"
  );
  let store: InstanceType<typeof EventSourcedConversationStore> | null = null;
  try {
    const raw = runtime.getConversationStore();
    store = raw instanceof EventSourcedConversationStore ? raw : null;
  } catch {
    /* no store in scope — fall through to null */
  }
  if (!store) return null;
  const path = join(store.getDir(), `${convId}.jsonl`);
  if (!existsSync(path)) return null;
  return store.readEvents(convId);
}

// ── bundle filter ────────────────────────────────────────────────────────

/**
 * Filter the response to one bundle's contributions in place. A layer is
 * kept if its top-level `bundle` matches OR if any of its `subItems`
 * carries the matching bundle. For sections with subItems, the subItems
 * array is also pared to just the matching ones.
 *
 * The `text` field is left intact even after filtering: reconstructing
 * a faithful per-bundle text slice would require re-running the
 * formatters with the filtered list, which is more change-surface than
 * v1 of this tool warrants. Consumers that need filtered text can
 * concatenate `layers.map(l => l.text)`; the per-bundle composition is
 * better served by clicking through to source IDs anyway.
 */
function applyBundleFilter(response: ComposeResponse, bundle: string): void {
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
