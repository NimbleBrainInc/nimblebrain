// `ParticipantInfo` was the participants-section input; gone post Stage 1.
// Stage 4 reintroduces a participants concept with policy gating.
import { approxTokens } from "../skills/tokens.ts";
import type { Skill } from "../skills/types.ts";

const SEPARATOR = "\n\n---\n\n";

/**
 * A single section of the composed system prompt, captured with provenance.
 *
 * The traced compose pipeline (`composeSystemPromptTraced`) emits one
 * `TracedLayer` per section that ends up in the prompt, in the order they
 * appear. Joining `layers.map(l => l.text)` with `SEPARATOR` reconstructs
 * the same string `composeSystemPrompt` returns — the trace is non-lossy.
 *
 * `subItems` is populated for sections that aggregate multiple operator-
 * authored entries (apps, layer3 skills). It lets debug tools render per-
 * item attribution, filter by bundle, and detect content drift on a
 * per-skill basis without re-parsing the section text.
 */
export interface TracedLayer {
  kind: TracedLayerKind;
  /**
   * Stable identifier. Filesystem path for file-backed layers; `nb:<slug>`
   * for runtime-derived layers; `instructions://<scope>` for overlays.
   */
  id: string;
  /** Human-readable origin (display string for the debug tool's row UI). */
  source: string;
  /** The text contribution this layer makes to the composed prompt. */
  text: string;
  /** Approximate tokens for `text`. */
  tokens: number;
  /**
   * Bundle attribution, when applicable. For the apps section / focused-app
   * section / layer3-skills under a bundles/<name>/ subdir. Used by the
   * compose-effective-context tool's `bundle` filter.
   */
  bundle?: string;
  /**
   * Per-entry breakdown for sections that aggregate multiple operator-
   * authored items. Empty / absent for atomic sections.
   */
  subItems?: TracedSubItem[];
}

export type TracedLayerKind =
  | "default_identity"
  | "core_skill"
  | "user_context_skill"
  | "user_prefs"
  | "workspace_context"
  | "org_overlay"
  | "workspace_overlay"
  | "layer3_skills"
  | "apps"
  | "app_state"
  | "focused_app"
  | "matched_skill";

export interface TracedSubItem {
  /** Item kind — finer-grained than the parent layer's kind. */
  kind: "app" | "layer3_skill";
  /** Stable identifier — filesystem path for skills; bundle name for apps. */
  id: string;
  /** Human-readable display. */
  source: string;
  /** Bundle attribution when known. Drives the `bundle` filter. */
  bundle?: string;
  /** Free-form metadata appropriate to the kind (skill scope, app trustScore, etc.). */
  metadata?: Record<string, unknown>;
}

export interface ComposedPrompt {
  text: string;
  layers: TracedLayer[];
  totalTokens: number;
}

/**
 * Strip newlines and control characters from single-line fields.
 * Prevents structural injection via displayName, timezone, locale, app name.
 */
function sanitizeLineField(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping control chars is the security mitigation
  return value.replace(/[\n\r\x00-\x1f\x7f]/g, " ").trim();
}

/** Skills with priority ≤ this threshold are core context (identity layer). */
export const CORE_PRIORITY_THRESHOLD = 10;

export const DEFAULT_IDENTITY = `You are a helpful assistant powered by NimbleBrain.

You have access to tools provided via the API. When a user asks you to do something, use your tools to accomplish it. Do not guess or make up answers when you have tools that can find the real answer. If you're unsure, try using a tool first.

Be concise and direct. Lead with actions, not explanations.

IMPORTANT: Only use tools that are provided to you via the tools parameter. Never fabricate tool calls as XML, JSON, or any other text format.`;

/** Lightweight app descriptor for system prompt injection. */
export interface PromptAppInfo {
  name: string;
  description?: string;
  /**
   * Optional per-bundle guidance from the MCP server's `initialize.instructions`
   * field. Rendered inside `<app-instructions>` containment tags so the model
   * treats the content as data, not a nested system prompt.
   */
  instructions?: string;
  /**
   * Optional workspace-admin overlay text for this bundle. Rendered inside a
   * sibling `<app-custom-instructions>` tag using the same containment-escape
   * pattern as `instructions`. The overlay text comes from the platform
   * instructions store, NOT from the bundle author — it's the workspace's
   * say over how the agent should behave when using this bundle.
   */
  customInstructions?: string;
  trustScore: number;
  ui: { name: string } | null;
}

/**
 * Per-scope overlay text injected after the identity layer. Each scope
 * is independent: an empty string (or undefined) skips the layer entirely,
 * leaving no marker tag in the assembled prompt.
 */
export interface OverlayLayers {
  /** Org-level overlay (Phase 3 — slot reserved; Phase 1 callers pass `""`). */
  org?: string;
  /** Workspace-level overlay (Phase 2 — slot reserved; Phase 1 callers pass `""`). */
  workspace?: string;
}

/**
 * Layer 3 skill picked by `selectLayer3Skills` for the current turn.
 *
 * The compose layer renders the body inside a `<layer3-skill>` containment
 * tag with a provenance heading naming the source path so a debug reader
 * can attribute each block to its origin. Empty `body` skips the entry
 * (no marker tag emitted).
 */
export interface Layer3SkillEntry {
  name: string;
  body: string;
  scope: "org" | "workspace" | "user" | "bundle";
  sourcePath?: string;
  loadedBy: "always" | "tool_affinity";
  reason: string;
}

/** Descriptor for the app the user is currently viewing alongside the chat. */
export interface FocusedAppInfo {
  name: string;
  tools: Array<{ name: string; description: string }>;
  skillResource?: string;
  /** URI of a reference resource with detailed tool catalog / error recovery.
   *  When set, a hint is appended after the app guide telling the agent where to find it. */
  referenceResourceUri?: string;
  trustScore: number;
}

/** App state entry from the bridge's appStateStore. */
export interface AppStateInfo {
  state: Record<string, unknown>;
  summary?: string;
  updatedAt: string;
  trustScore: number;
}

/** User preferences injected into the system prompt so the agent knows
 *  the user's identity without needing a tool call. */
export interface UserPrefs {
  displayName: string;
  timezone: string;
  locale: string;
}

/** Workspace context injected into the system prompt so the agent knows
 *  which workspace the conversation belongs to. */
export interface WorkspaceContext {
  id: string;
  name?: string;
}

/**
 * Compose the system prompt from context skills and an optional matched skill.
 *
 * Context skills are sorted by priority (caller's responsibility).
 * If no context skills are provided, DEFAULT_IDENTITY is used as fallback.
 * The matched skill body is appended last.
 * If apps are provided and non-empty, an "## Installed Apps" section is injected.
 */
export function composeSystemPrompt(
  contextSkills: Skill[],
  matchedSkill?: Skill | null,
  apps?: PromptAppInfo[],
  focusedApp?: FocusedAppInfo,
  appState?: AppStateInfo,
  userPrefs?: UserPrefs,
  hasProxiedTools?: boolean,
  workspaceContext?: WorkspaceContext,
  overlays?: OverlayLayers,
  layer3Skills?: Layer3SkillEntry[],
): string {
  return composeSystemPromptTraced(
    contextSkills,
    matchedSkill,
    apps,
    focusedApp,
    appState,
    userPrefs,
    hasProxiedTools,
    workspaceContext,
    overlays,
    layer3Skills,
  ).text;
}

/**
 * Traced variant of `composeSystemPrompt` — same composition logic,
 * returns a per-section breakdown alongside the joined text.
 *
 * Joining `layers.map(l => l.text)` with `SEPARATOR` reproduces the
 * string `composeSystemPrompt` returns. The trace is non-lossy by
 * construction: this function is the single source of truth for layer
 * order; the string variant is derived by joining `.text`.
 *
 * Used by the `compose_effective_context` debug tool. No additional
 * filesystem access vs. the string variant — works over the same
 * already-resolved inputs the runtime gathers for `runtime.chat()`.
 */
export function composeSystemPromptTraced(
  contextSkills: Skill[],
  matchedSkill?: Skill | null,
  apps?: PromptAppInfo[],
  focusedApp?: FocusedAppInfo,
  appState?: AppStateInfo,
  userPrefs?: UserPrefs,
  hasProxiedTools?: boolean,
  workspaceContext?: WorkspaceContext,
  overlays?: OverlayLayers,
  layer3Skills?: Layer3SkillEntry[],
): ComposedPrompt {
  const layers: TracedLayer[] = [];

  // Separate core context (priority ≤ threshold) from user context (priority > threshold).
  const coreContext: Skill[] = [];
  const userContext: Skill[] = [];
  for (const ctx of contextSkills) {
    if (ctx.manifest.priority <= CORE_PRIORITY_THRESHOLD) {
      coreContext.push(ctx);
    } else {
      userContext.push(ctx);
    }
  }

  // Layer 0: Core context bodies (identity layer). One row per skill so
  // a debug reader can attribute identity content to the file it came
  // from (soul.md, capabilities.md, etc.).
  for (const ctx of coreContext) {
    if (ctx.body) {
      layers.push({
        kind: "core_skill",
        id: ctx.sourcePath || `core:${ctx.manifest.name}`,
        source: ctx.sourcePath || `core skill "${ctx.manifest.name}"`,
        text: ctx.body,
        tokens: approxTokens(ctx.body),
      });
    }
  }

  // Fallback to default identity if no core context skills produced content.
  if (layers.length === 0) {
    layers.push({
      kind: "default_identity",
      id: "nb:default-identity",
      source: "platform default (no core context skills loaded)",
      text: DEFAULT_IDENTITY,
      tokens: approxTokens(DEFAULT_IDENTITY),
    });
  }

  // Layer 1: User context bodies (priority > 10, type: context, always-on).
  for (const ctx of userContext) {
    if (ctx.body) {
      layers.push({
        kind: "user_context_skill",
        id: ctx.sourcePath || `nb:user-context:${ctx.manifest.name}`,
        source: ctx.sourcePath || `user context skill "${ctx.manifest.name}"`,
        text: ctx.body,
        tokens: approxTokens(ctx.body),
      });
    }
  }

  // Layer 1.5: User preferences (name, timezone, locale) + current date.
  // Always emitted — ensures the model knows "today" even with no prefs.
  const prefsText = formatUserPrefs(userPrefs);
  layers.push({
    kind: "user_prefs",
    id: "nb:user-prefs",
    source: "runtime — user preferences + current date",
    text: prefsText,
    tokens: approxTokens(prefsText),
  });

  // Layer 1.6: Participants section — removed in Stage 1 (single-owner
  // conversations). Returns in Stage 4 with policy-gated sharing.

  // Layer 1.7: Workspace context. Either the focused workspace, or — at the
  // identity-level home (no focus) — an EXPLICIT statement that there's no
  // current workspace. The explicit form matters: without it the prompt is
  // silent on scope, and an agent asked "which workspace am I in?" reaches for
  // a workspace-namespaced tool and reports an arbitrary one.
  if (workspaceContext) {
    const wsText = formatWorkspaceContext(workspaceContext);
    layers.push({
      kind: "workspace_context",
      id: "nb:workspace-context",
      source: `runtime — workspace ${workspaceContext.id}`,
      text: wsText,
      tokens: approxTokens(wsText),
    });
  } else {
    const wsText = formatNoWorkspaceContext();
    layers.push({
      kind: "workspace_context",
      id: "nb:no-workspace-context",
      source: "runtime — identity-level home (no focused workspace)",
      text: wsText,
      tokens: approxTokens(wsText),
    });
  }

  // Layer 1.8: Org / workspace instruction overlays.
  if (overlays?.org && overlays.org.trim().length > 0) {
    const text = formatScopeOverlay("Organization Instructions", overlays.org);
    layers.push({
      kind: "org_overlay",
      id: "instructions://org",
      source: "org-tier instruction overlay",
      text,
      tokens: approxTokens(text),
    });
  }
  if (overlays?.workspace && overlays.workspace.trim().length > 0) {
    const text = formatScopeOverlay("Workspace Instructions", overlays.workspace);
    layers.push({
      kind: "workspace_overlay",
      id: "instructions://workspace",
      source: "workspace-tier instruction overlay",
      text,
      tokens: approxTokens(text),
    });
  }

  // Layer 1.9: Layer 3 skills section. One TracedLayer for the whole
  // section; per-skill detail in `subItems` so the debug tool can filter
  // / inspect / hash-verify each skill independently. Empty list skips
  // the section entirely (no marker, no row).
  if (layer3Skills && layer3Skills.length > 0) {
    const section = formatLayer3SkillsSection(layer3Skills);
    if (section) {
      layers.push({
        kind: "layer3_skills",
        id: "nb:layer3-skills",
        source: `layer 3 skills (${layer3Skills.length} loaded)`,
        text: section,
        tokens: approxTokens(section),
        subItems: layer3Skills
          .filter((entry) => entry.body && entry.body.trim().length > 0)
          .map((entry) => {
            const bundle = deriveBundleFromSkillPath(entry.sourcePath);
            return {
              kind: "layer3_skill" as const,
              id: entry.sourcePath ?? `nb:layer3:${entry.name}`,
              source: entry.sourcePath ?? entry.name,
              ...(bundle !== undefined ? { bundle } : {}),
              metadata: {
                name: entry.name,
                scope: entry.scope,
                loadedBy: entry.loadedBy,
                reason: entry.reason,
              },
            };
          }),
      });
    }
  }

  // Layer 2: Installed apps section. One TracedLayer for the section;
  // per-app detail in `subItems`. Each subItem carries the bundle name
  // so a `bundle` filter on the debug tool can pick out a single app's
  // contribution from the section text.
  if (apps && apps.length > 0) {
    const text = formatAppsSection(apps, hasProxiedTools);
    layers.push({
      kind: "apps",
      id: "nb:apps",
      source: `installed apps (${apps.length})`,
      text,
      tokens: approxTokens(text),
      subItems: apps.map((app) => ({
        kind: "app" as const,
        id: app.name,
        source: app.name,
        bundle: app.name,
        metadata: {
          description: app.description,
          hasInstructions: !!app.instructions,
          hasCustomInstructions:
            !!app.customInstructions && app.customInstructions.trim().length > 0,
          trustScore: app.trustScore,
          ui: app.ui,
        },
      })),
    });
  }

  // Layer 2.5: Active app state (Synapse Feature 2). May return null if
  // the trust score is below threshold — skip the layer in that case.
  if (appState) {
    const stateSection = formatAppStateSection(appState);
    if (stateSection) {
      layers.push({
        kind: "app_state",
        id: "nb:app-state",
        source: "runtime — focused-app state",
        text: stateSection,
        tokens: approxTokens(stateSection),
      });
    }
  }

  // Layer 3: Focused app section.
  if (focusedApp) {
    const text = formatFocusedAppSection(focusedApp);
    layers.push({
      kind: "focused_app",
      id: "nb:focused-app",
      source: `focused app: ${focusedApp.name}`,
      text,
      tokens: approxTokens(text),
      bundle: focusedApp.name,
    });
  }

  // Layer 4: Matched skill (legacy SkillMatcher path).
  if (matchedSkill?.body) {
    const text = `<skill-instructions>\n${matchedSkill.body}\n</skill-instructions>`;
    layers.push({
      kind: "matched_skill",
      id: matchedSkill.sourcePath || `nb:matched-skill:${matchedSkill.manifest.name}`,
      source: matchedSkill.sourcePath ?? `matched skill "${matchedSkill.manifest.name}"`,
      text,
      tokens: approxTokens(text),
    });
  }

  const text = layers.map((l) => l.text).join(SEPARATOR);
  const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
  return { text, layers, totalTokens };
}

/**
 * Heuristic: if a Layer 3 skill lives under `.../skills/bundles/<name>/`
 * (the documented convention for bundle-affined L3 skills), attribute it
 * to that bundle. Otherwise return undefined — the skill is bundle-
 * agnostic and the `bundle` filter shouldn't claim it.
 *
 * Exported so other surfaces (e.g. the historical-audit path in
 * `tools/platform/compose.ts`) classify skills the same way as the live
 * trace — drift between the two would silently mis-attribute the bundle
 * filter.
 */
export function deriveBundleFromSkillPath(sourcePath?: string): string | undefined {
  if (!sourcePath) return undefined;
  const m = sourcePath.match(/\/skills\/bundles\/([^/]+)\//);
  return m?.[1];
}

function formatAppsSection(apps: PromptAppInfo[], hasProxiedTools?: boolean): string {
  const lines = ["## Installed Apps"];
  for (const app of apps) {
    const uiLabel = app.ui ? `has UI: ${app.ui.name}` : "no UI";
    const trustLabel = app.trustScore != null ? ` — MTF Score: ${app.trustScore}` : "";
    lines.push(`- ${app.name} (${uiLabel})${trustLabel}`);
    if (app.description) {
      lines.push(`  <app-description>${app.description}</app-description>`);
    }
    if (app.instructions) {
      // Neutralize any attempt by the bundle author to close the containment
      // tag early and inject a forged system section. We do NOT strip
      // arbitrary XML, only the specific tag we use for containment.
      const safe = app.instructions.replaceAll("</app-instructions>", "&lt;/app-instructions>");
      lines.push(`  <app-instructions>\n${safe}\n  </app-instructions>`);
    }
    if (app.customInstructions && app.customInstructions.trim().length > 0) {
      // Mirror the `<app-instructions>` containment escape byte-for-byte —
      // this is a prompt-injection mitigation. The overlay text comes from
      // the workspace admin (via the platform instructions store), not from
      // the bundle author, but the same containment guarantee applies.
      const safe = app.customInstructions.replaceAll(
        "</app-custom-instructions>",
        "&lt;/app-custom-instructions>",
      );
      lines.push(`  <app-custom-instructions>\n${safe}\n  </app-custom-instructions>`);
    }
  }
  lines.push(
    "",
    "When you create or modify data in apps that have a UI, mention that the user can view the result in the sidebar.",
  );
  if (hasProxiedTools) {
    lines.push(
      "",
      '**Important:** These apps have tools that are not in your direct tool list. To use an app\'s tools, call `nb__search` with `scope: "tools"` and a keyword (e.g., "contact", "invoice", "document") to discover exact tool names, then call `nb__manage_tools` with `{ "add": ["source__tool", ...] }` to make them callable on the next turn. When you switch domains, patch in one call with `{ "add": [...], "remove": [...] }`. Tool names use the format `source__tool` (e.g., `synapse-crm__create_contact`). Never guess tool names — always discover them first.',
    );
  }
  return lines.join("\n");
}

const INTERACTION_RULES = `### Interaction Rules

- When the user describes a change, identify which tool achieves it and call it directly. Do not ask for confirmation unless the action is destructive or ambiguous.
- After making changes, briefly confirm what you did. The app view refreshes automatically — do not describe the UI.
- If unsure which tool to use, call \`nb__search\` with \`scope: "tools"\` and a keyword. If the chosen tool is not currently callable, add it via \`nb__manage_tools({ add: ["source__tool"] })\` before using it. Default to retain — only remove tools when clearly switching domains, batched into the same patch as the new adds.
- When the user says "undo" or "go back," check if the app has undo, snapshot, or history tools. If not, say undo is not available for this app.
- When the user gives vague feedback ("I don't like it," "make it better"), ask ONE clarifying question about what specifically to change.
- Messages may include an \`[App Context: ...]\` header with metadata from the app. Use it to understand what the user was looking at.
- Other apps are still available via \`nb__search\` (scope: "tools") if the user's request spans apps; add discovered tools via \`nb__manage_tools\` before calling them.`;

function formatFocusedAppSection(focusedApp: FocusedAppInfo): string {
  const safeName = sanitizeLineField(focusedApp.name);
  const lines = [`## Active App: ${safeName}`];
  lines.push("");
  lines.push(
    `The user is currently viewing the **${safeName}** app alongside this chat. Their messages likely relate to this app.`,
  );
  lines.push("");
  lines.push("### App Guide");
  lines.push("");
  // Trust is enforced at install time, not per-prompt: if a bundle is active
  // in the workspace its tools are already callable, so suppressing the
  // workflow guidance that teaches the model how to use them safely would
  // make the situation worse, not better. Tool descriptions, tool outputs,
  // and `app://instructions` flow through ungated already.
  if (focusedApp.skillResource) {
    // Escape any embedded `</app-guide>` so a bundle-authored skill body
    // cannot break out of containment. Matches the pattern used for
    // `<app-state>` (l. 584), `<app-instructions>` (l. 494), and
    // `<layer3-skill>` (l. 632).
    const safeGuide = focusedApp.skillResource.replaceAll("</app-guide>", "&lt;/app-guide>");
    lines.push(`<app-guide>\n${safeGuide}\n</app-guide>`);
    if (focusedApp.referenceResourceUri) {
      lines.push("");
      lines.push(
        `For detailed tool guidance, error recovery, and reference material, read the \`${focusedApp.referenceResourceUri}\` resource.`,
      );
    }
  } else {
    lines.push("No app-specific guide available. Use the available tools to help the user.");
  }
  lines.push("");
  lines.push(INTERACTION_RULES);
  return lines.join("\n");
}

/** Max tokens for app state in the prompt. */
const MAX_STATE_TOKENS = 4096;

/**
 * Format the app state section for injection into the system prompt.
 * See `<app-guide>` injection above for the trust-at-install rationale.
 */
function formatAppStateSection(appState: AppStateInfo): string | null {
  const stateJson = JSON.stringify(appState.state, null, 2);
  // Rough token estimate: 1 token ≈ 4 chars
  const estimatedTokens = Math.ceil(stateJson.length / 4);

  let inner: string;
  if (estimatedTokens <= MAX_STATE_TOKENS) {
    inner = stateJson;
  } else if (appState.summary) {
    inner = appState.summary;
  } else {
    inner = `${stateJson.slice(0, MAX_STATE_TOKENS * 4)}\n[state truncated — ask user for details]`;
  }

  const escaped = inner.replaceAll("</app-state>", "&lt;/app-state>");
  return `## Current App State\nLast updated: ${appState.updatedAt}\n\n<app-state>\n${escaped}\n</app-state>`;
}

/**
 * Format a top-level instruction overlay (org- or workspace-scope).
 *
 * Each overlay sits in a containment tag whose name matches its scope, so
 * a debug reader can attribute the body to its source. The escape pattern
 * matches `<app-instructions>` — any literal closing tag inside the body
 * is rewritten to `&lt;/...>` before wrapping, defending against prompt
 * injection from a writer who tries to break out of containment.
 */
function formatScopeOverlay(heading: string, body: string): string {
  const tag =
    heading === "Organization Instructions" ? "org-instructions" : "workspace-instructions";
  const safe = body.replaceAll(`</${tag}>`, `&lt;/${tag}>`);
  return `## ${heading}\n\n<${tag}>\n${safe}\n</${tag}>`;
}

/**
 * Render the Layer 3 skills section. Each selected skill becomes a
 * sub-section with a provenance line (name / scope / loaded-by reason),
 * its body wrapped in `<layer3-skill>` containment. The wrap prevents a
 * skill author from injecting a forged closing tag and breaking
 * containment — same pattern as `<app-instructions>`.
 */
function formatLayer3SkillsSection(entries: Layer3SkillEntry[]): string | null {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (!entry.body || entry.body.trim().length === 0) continue;
    const safeName = sanitizeLineField(entry.name);
    const safeScope = sanitizeLineField(entry.scope);
    const safeReason = sanitizeLineField(entry.reason);
    const safeBody = entry.body.replaceAll("</layer3-skill>", "&lt;/layer3-skill>");
    const provenance = `_${safeName}_ — scope: ${safeScope}; loaded: ${entry.loadedBy} (${safeReason})`;
    blocks.push(`### ${safeName}\n\n${provenance}\n\n<layer3-skill>\n${safeBody}\n</layer3-skill>`);
  }
  if (blocks.length === 0) return null;
  return `## Skills\n\n${blocks.join("\n\n")}`;
}

function formatWorkspaceContext(ws: WorkspaceContext): string {
  const lines = ["## Workspace", ""];
  lines.push(`- ID: ${sanitizeLineField(ws.id)}`);
  if (ws.name) lines.push(`- Name: ${sanitizeLineField(ws.name)}`);
  lines.push("");
  lines.push(
    "Your active tools are this workspace's — its apps plus the platform tools. Tools in the user's OTHER workspaces, and their personal tools (e.g. email), are NOT loaded right now. Find any tool across all of the user's workspaces with `nb__search`; matches are added to your tools on demand. Don't assume a tool is missing — search first.",
  );
  return lines.join("\n");
}

/**
 * Workspace block for the identity-level home (no focused workspace). States
 * plainly that there is no current workspace, so the agent answers "which
 * workspace am I in?" from context instead of calling a workspace-namespaced
 * tool and reporting an arbitrary one — and points at `nb__search` for tools
 * that aren't in the home active set.
 */
function formatNoWorkspaceContext(): string {
  return [
    "## Workspace",
    "",
    "The user is at their identity-level home — **not in any single workspace**. There is no current workspace. If the user asks which workspace they're in, tell them they're at their home view, not a specific one.",
    "",
    "Your active tools are the platform tools and the user's own (conversations, personal). Tools that belong to a specific workspace are NOT loaded here. Find any tool across all of the user's workspaces with `nb__search`; matches are added to your tools on demand. Don't assume a tool is missing — search first.",
  ].join("\n");
}

function formatUserPrefs(prefs?: UserPrefs): string {
  const lines: string[] = [];
  if (prefs?.displayName) lines.push(`- Name: ${sanitizeLineField(prefs.displayName)}`);
  if (prefs?.timezone) lines.push(`- Timezone: ${sanitizeLineField(prefs.timezone)}`);

  // Always include current date so the model knows "today"
  const now = new Date();
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  if (prefs?.timezone) {
    try {
      // Validate the timezone before using it (may be untrusted input)
      Intl.DateTimeFormat("en-US", { timeZone: prefs.timezone });
      dateOpts.timeZone = prefs.timezone;
    } catch {
      // Invalid timezone — fall back to system default
    }
  }
  const formatted = now.toLocaleDateString("en-US", dateOpts);
  lines.push(`- Today's date: ${formatted}`);

  if (prefs?.locale && prefs.locale !== "en-US")
    lines.push(`- Locale: ${sanitizeLineField(prefs.locale)}`);
  return `## User\n\n${lines.join("\n")}`;
}
