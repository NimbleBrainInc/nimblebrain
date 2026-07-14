// `ParticipantInfo` was the participants-section input; gone post Stage 1.
// Stage 4 reintroduces a participants concept with policy gating.
import { approxTokens } from "../skills/tokens.ts";
import type { Skill } from "../skills/types.ts";

const SEPARATOR = "\n\n---\n\n";

/**
 * The closed set of containment tags the composer may open around untrusted
 * body content. Membership here is the allow-list: you cannot wrap content in
 * a tag that is not in this union — an unknown tag is a compile error, which
 * kills the wrong-tag copy-paste class at type-check time.
 */
export type ContainmentTag =
  | "context-skill"
  | "runtime-context"
  | "app-instructions"
  | "app-custom-instructions"
  | "app-description"
  | "app-guide"
  | "app-state"
  | "org-instructions"
  | "workspace-instructions"
  | "layer3-skill"
  | "connector-skill"
  | "skill-instructions";

/**
 * Wrap untrusted `body` in `<tag>…</tag>`, neutralising every closing form of
 * `tag` inside `body` so the body cannot break out of containment. The open
 * tag, the escaped close form, and the trailing close are all derived from the
 * single `tag` argument — they are incapable of diverging. Returns the FULL
 * block (open + escaped body + close); callers never write the literal tag.
 *
 * The escape is case-insensitive and whitespace-tolerant on purpose: the
 * parser on the other side is an LLM, not a conforming XML reader, and it will
 * honor `</TAG>`, `</tag >`, `</ tag>`, `</tag\n>` as closes that an
 * exact-substring `replaceAll` would pass straight through. This is the
 * security-load-bearing behavior.
 */
export function wrapContained(tag: ContainmentTag, body: string): string {
  // `tag` values are fixed lowercase `[a-z-]` literals — no regex metachars to
  // escape. Do NOT widen `ContainmentTag` to include a regex metacharacter
  // without escaping it here. The `gi` flag plus `\s*` around the `/` and tag
  // normalise every realistic close variant — `</TAG>`, `</tag >`, `< /tag>`,
  // `</ tag>`, `</tag\n>` — to the single safe `&lt;/${tag}>`, since the
  // consumer is a fuzzy LLM parser rather than a conforming XML reader.
  const closing = new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi");
  const safe = body.replace(closing, `&lt;/${tag}>`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

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
   * Volatility tier. `volatile` layers (current date, app/focused-app state,
   * matched skill) change per turn and are evicted from the cached system
   * prefix onto the latest user message; `stable` layers form the cached
   * system prefix. See `composeSystemSegments`.
   */
  segment: "stable" | "volatile";
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
  | "task_identity"
  | "core_skill"
  | "user_context_skill"
  | "user_prefs"
  | "current_date"
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
 * Volatility-tiered system composition.
 *
 * `stableSystem` is the cacheable system prefix (identity, scoped skills,
 * overlays, apps). `volatileHead` is the per-turn-volatile content (current
 * date, app/focused-app state, matched skill) wrapped in a single
 * `<runtime-context>` block — the runtime prepends it to the latest user
 * message so a per-turn change no longer rewrites the cached system prefix.
 * `volatileHead` is "" when there is no volatile content.
 *
 * `layers` and `totalTokens` mirror `ComposedPrompt` (the full set, both tiers).
 */
export interface ComposedSegments {
  stableSystem: string;
  volatileHead: string;
  layers: TracedLayer[];
  totalTokens: number;
}

/** Layer kinds that change per turn — evicted from the cached system block. */
const VOLATILE_KINDS: ReadonlySet<TracedLayerKind> = new Set([
  "current_date",
  "app_state",
  "focused_app",
  "matched_skill",
]);

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

/**
 * Identity framing for task-mode invocations (e.g. scheduled automations,
 * eval runs, future webhook-triggered jobs). Prepended above the core
 * skills when `composeSystemPrompt({ mode: "task" })`. The runtime owns
 * this contract; bundles cannot spoof it by wrapping the user message.
 *
 * The contract: artifact production, no follow-up questions, factual
 * gap-handling, markdown by default.
 */
export const TASK_IDENTITY = `You are running as an automated task. The user is not present at this time, so there is nobody available to answer questions or confirm choices — decide and proceed using the tools and context available.

Produce a finished, self-contained deliverable as your final response. Format as markdown unless the task description specifies otherwise. Do not greet, acknowledge ("Sure, let me…"), or close with follow-up questions ("Want me to dig deeper?"). If required data is missing or unavailable, state the gap factually within the deliverable and continue with what you can produce — do not stop and ask.

You still have full access to tools and can call them as many times as the task needs. The deliverable is your final assistant message, not an intermediate one.`;

/** Invocation mode. `chat` is the conversational surface; `task` is the
 *  unattended artifact-production surface (automations, evals, etc.). */
export type ComposeMode = "chat" | "task";

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
  mode?: ComposeMode,
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
    mode,
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
  mode: ComposeMode = "chat",
): ComposedPrompt {
  const layers: PendingLayer[] = [];

  // Layer 0a (task mode) then Layer 0 (core identity), with the default-identity
  // fallback applied only when neither produced content. In task mode the
  // TASK_IDENTITY layer already supplies framing, so `layers` is non-empty here
  // and the fallback is skipped — the two would give the model contradictory
  // role definitions.
  layers.push(...taskIdentityLayers(mode));
  const { core, user } = partitionContextSkills(contextSkills);
  layers.push(...coreContextLayers(core));
  if (layers.length === 0) {
    layers.push(defaultIdentityLayer());
  }

  // Layer 1: tenant-authored user context (priority > threshold).
  layers.push(...userContextLayers(user));

  // Layer 1.5a: stable user identity. Layer 1.5b: always-emitted volatile date.
  layers.push(...userIdentityLayers(userPrefs));
  layers.push(...currentDateLayers(userPrefs));

  // Layer 1.6: Participants section — removed in Stage 1 (single-owner
  // conversations). Returns in Stage 4 with policy-gated sharing.

  // Layers 1.7 → 4, in prompt order: workspace context, org/workspace overlays,
  // Layer 3 skills, installed apps, app state, focused app, matched skill.
  layers.push(...workspaceContextLayers(workspaceContext));
  layers.push(...overlayLayers(overlays));
  layers.push(...layer3SkillsLayers(layer3Skills));
  layers.push(...appsLayers(apps, hasProxiedTools));
  layers.push(...appStateLayers(appState));
  layers.push(...focusedAppLayers(focusedApp));
  layers.push(...matchedSkillLayers(matchedSkill));

  // Stamp the volatility tier from the layer kind (single source of truth for
  // the stable/volatile classification — see `composeSystemSegments`).
  const tagged: TracedLayer[] = layers.map((l) => ({
    ...l,
    segment: VOLATILE_KINDS.has(l.kind) ? "volatile" : "stable",
  }));
  const text = tagged.map((l) => l.text).join(SEPARATOR);
  const totalTokens = tagged.reduce((sum, l) => sum + l.tokens, 0);
  return { text, layers: tagged, totalTokens };
}

/** A composed layer before its volatility `segment` is stamped in the final pass. */
type PendingLayer = Omit<TracedLayer, "segment">;

/**
 * Layer 0a (task mode only): the TASK_IDENTITY contract, prepended before any
 * core skill so the framing is read first. The runtime owns this layer — bundles
 * cannot remove or override it by wrapping the user message. Workspace `soul.md`
 * and similar core skills still layer in below; their domain identity composes
 * with, not against, the task contract.
 */
function taskIdentityLayers(mode: ComposeMode): PendingLayer[] {
  if (mode !== "task") return [];
  return [
    {
      kind: "task_identity",
      id: "nb:task-identity",
      source: "platform task-mode contract",
      text: TASK_IDENTITY,
      tokens: approxTokens(TASK_IDENTITY),
    },
  ];
}

/**
 * Split context skills into core (priority ≤ threshold, rendered RAW in Layer 0)
 * and user (priority > threshold, wrapped in `<context-skill>` containment).
 *
 * `bundle`-scoped skills are ALWAYS placed in the `user` bucket regardless of
 * priority: they carry server-authored content, which must never render as raw
 * trusted identity in Layer 0 (that would be a prompt-injection vector). This is
 * the same install-time-not-per-prompt trust posture as the other bundle-authored
 * containment tags (`<app-guide>`, `<app-state>`, `<layer3-skill>`) — the defense
 * is XML containment, so a server that declares `loading-strategy: always` with a
 * low priority still gets contained, not promoted into the identity layer.
 */
function partitionContextSkills(contextSkills: Skill[]): { core: Skill[]; user: Skill[] } {
  const core: Skill[] = [];
  const user: Skill[] = [];
  for (const ctx of contextSkills) {
    const isBundleAuthored = ctx.manifest.scope === "bundle";
    if (!isBundleAuthored && ctx.manifest.priority <= CORE_PRIORITY_THRESHOLD) {
      core.push(ctx);
    } else {
      user.push(ctx);
    }
  }
  return { core, user };
}

/**
 * Layer 0: core context bodies (identity layer). One row per skill so a debug
 * reader can attribute identity content to the file it came from (soul.md,
 * capabilities.md, etc.).
 */
function coreContextLayers(coreContext: Skill[]): PendingLayer[] {
  const layers: PendingLayer[] = [];
  for (const ctx of coreContext) {
    if (!ctx.body) continue;
    layers.push({
      kind: "core_skill",
      id: ctx.sourcePath || `core:${ctx.manifest.name}`,
      source: ctx.sourcePath || `core skill "${ctx.manifest.name}"`,
      text: ctx.body,
      tokens: approxTokens(ctx.body),
    });
  }
  return layers;
}

/** Platform default identity — the fallback when no core-context skill produced content. */
function defaultIdentityLayer(): PendingLayer {
  return {
    kind: "default_identity",
    id: "nb:default-identity",
    source: "platform default (no core context skills loaded)",
    text: DEFAULT_IDENTITY,
    tokens: approxTokens(DEFAULT_IDENTITY),
  };
}

/**
 * Layer 1: user context bodies (priority > 10, loading-strategy: always). These
 * are tenant-authored — org/workspace/user "rules" from the settings UI — so each
 * body is wrapped in <context-skill> containment with its closing tag escaped, the
 * same prompt-injection discipline as <layer3-skill> and <app-*>. (Core identity
 * skills, priority ≤ threshold, are vendored and render raw in Layer 0.)
 */
function userContextLayers(userContext: Skill[]): PendingLayer[] {
  const layers: PendingLayer[] = [];
  for (const ctx of userContext) {
    if (!ctx.body) continue;
    const text = wrapContained("context-skill", ctx.body);
    layers.push({
      kind: "user_context_skill",
      id: ctx.sourcePath || `nb:user-context:${ctx.manifest.name}`,
      source: ctx.sourcePath || `user context skill "${ctx.manifest.name}"`,
      text,
      tokens: approxTokens(text),
    });
  }
  return layers;
}

/**
 * Layer 1.5a: user identity (name, timezone, locale) — STABLE, stays in the
 * cached system prefix. Empty when no identity fields are set (no empty `## User`
 * heading).
 */
function userIdentityLayers(userPrefs?: UserPrefs): PendingLayer[] {
  const identityText = formatUserIdentity(userPrefs);
  if (!identityText) return [];
  return [
    {
      kind: "user_prefs",
      id: "nb:user-prefs",
      source: "runtime — user identity",
      text: identityText,
      tokens: approxTokens(identityText),
    },
  ];
}

/**
 * Layer 1.5b: current date — VOLATILE (changes every turn). Its own layer so it
 * rides the latest user message instead of busting the 1h-cached system block.
 * Always emitted so the model knows "today".
 */
function currentDateLayers(userPrefs?: UserPrefs): PendingLayer[] {
  const dateText = formatCurrentDate(userPrefs);
  return [
    {
      kind: "current_date",
      id: "nb:current-date",
      source: "runtime — current date",
      text: dateText,
      tokens: approxTokens(dateText),
    },
  ];
}

/**
 * Layer 1.7: workspace context. Either the focused workspace, or — at the
 * identity-level home (no focus) — an EXPLICIT statement that there's no current
 * workspace. The explicit form matters: without it the prompt is silent on scope,
 * and an agent asked "which workspace am I in?" reaches for a workspace-namespaced
 * tool and reports an arbitrary one.
 */
function workspaceContextLayers(workspaceContext?: WorkspaceContext): PendingLayer[] {
  if (workspaceContext) {
    const wsText = formatWorkspaceContext(workspaceContext);
    return [
      {
        kind: "workspace_context",
        id: "nb:workspace-context",
        source: `runtime — workspace ${workspaceContext.id}`,
        text: wsText,
        tokens: approxTokens(wsText),
      },
    ];
  }
  const wsText = formatNoWorkspaceContext();
  return [
    {
      kind: "workspace_context",
      id: "nb:no-workspace-context",
      source: "runtime — identity-level home (no focused workspace)",
      text: wsText,
      tokens: approxTokens(wsText),
    },
  ];
}

/** Layer 1.8: org- and workspace-tier instruction overlays, each skipped when blank. */
function overlayLayers(overlays?: OverlayLayers): PendingLayer[] {
  const layers: PendingLayer[] = [];
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
  return layers;
}

/**
 * Layer 1.9: Layer 3 skills section. One TracedLayer for the whole section;
 * per-skill detail in `subItems` so the debug tool can filter / inspect /
 * hash-verify each skill independently. Empty when the list is empty or the
 * formatted section is null (no marker, no row).
 */
function layer3SkillsLayers(layer3Skills?: Layer3SkillEntry[]): PendingLayer[] {
  if (!layer3Skills || !(layer3Skills.length > 0)) return [];
  const section = formatLayer3SkillsSection(layer3Skills);
  if (!section) return [];
  return [
    {
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
    },
  ];
}

/**
 * Layer 2: installed apps section. One TracedLayer for the section; per-app
 * detail in `subItems`. Each subItem carries the bundle name so a `bundle` filter
 * on the debug tool can pick out a single app's contribution from the section text.
 */
function appsLayers(apps?: PromptAppInfo[], hasProxiedTools?: boolean): PendingLayer[] {
  if (!apps || !(apps.length > 0)) return [];
  const text = formatAppsSection(apps, hasProxiedTools);
  return [
    {
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
    },
  ];
}

/**
 * Layer 2.5: active app state (Synapse Feature 2). Empty when there's no app
 * state, or when `formatAppStateSection` returns null (trust score below
 * threshold) — skip the layer in that case.
 */
function appStateLayers(appState?: AppStateInfo): PendingLayer[] {
  if (!appState) return [];
  const stateSection = formatAppStateSection(appState);
  if (!stateSection) return [];
  return [
    {
      kind: "app_state",
      id: "nb:app-state",
      source: "runtime — focused-app state",
      text: stateSection,
      tokens: approxTokens(stateSection),
    },
  ];
}

/** Layer 3: focused app section — the app the user is viewing alongside the chat. */
function focusedAppLayers(focusedApp?: FocusedAppInfo): PendingLayer[] {
  if (!focusedApp) return [];
  const text = formatFocusedAppSection(focusedApp);
  return [
    {
      kind: "focused_app",
      id: "nb:focused-app",
      source: `focused app: ${focusedApp.name}`,
      text,
      tokens: approxTokens(text),
      bundle: focusedApp.name,
    },
  ];
}

/** Layer 4: matched skill (legacy SkillMatcher path), wrapped in <skill-instructions> containment. */
function matchedSkillLayers(matchedSkill?: Skill | null): PendingLayer[] {
  if (!matchedSkill?.body) return [];
  const text = wrapContained("skill-instructions", matchedSkill.body);
  return [
    {
      kind: "matched_skill",
      id: matchedSkill.sourcePath || `nb:matched-skill:${matchedSkill.manifest.name}`,
      source: matchedSkill.sourcePath ?? `matched skill "${matchedSkill.manifest.name}"`,
      text,
      tokens: approxTokens(text),
    },
  ];
}

/**
 * Volatility-tiered variant of `composeSystemPromptTraced`.
 *
 * Same composition (delegates to the traced builder — single source of truth
 * for layer order and classification), but splits the result into the cacheable
 * `stableSystem` prefix and the per-turn `volatileHead`. The runtime sends
 * `stableSystem` as the system block (so a per-turn change no longer rewrites
 * the 1h-cached prefix) and prepends `volatileHead` to the latest user message.
 */
export function composeSystemSegments(
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
  mode: ComposeMode = "chat",
): ComposedSegments {
  const composed = composeSystemPromptTraced(
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
    mode,
  );
  const stableSystem = composed.layers
    .filter((l) => l.segment === "stable")
    .map((l) => l.text)
    .join(SEPARATOR);
  const volatileBody = composed.layers
    .filter((l) => l.segment === "volatile")
    .map((l) => l.text)
    .join(SEPARATOR);
  // Contain the volatile head so the model reads it as runtime-injected context,
  // not user authorship. Escape any forged closing tag, same discipline as the
  // per-block tags (which keep their own escapes inside `volatileBody`).
  const volatileHead =
    volatileBody.length > 0 ? wrapContained("runtime-context", volatileBody) : "";
  return {
    stableSystem,
    volatileHead,
    layers: composed.layers,
    totalTokens: composed.totalTokens,
  };
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
      lines.push(wrapContained("app-description", app.description));
    }
    if (app.instructions) {
      // Neutralize any attempt by the bundle author to close the containment
      // tag early and inject a forged system section. We do NOT strip
      // arbitrary XML, only the specific tag we use for containment.
      lines.push(wrapContained("app-instructions", app.instructions));
    }
    if (app.customInstructions && app.customInstructions.trim().length > 0) {
      // Mirror the `<app-instructions>` containment escape byte-for-byte —
      // this is a prompt-injection mitigation. The overlay text comes from
      // the workspace admin (via the platform instructions store), not from
      // the bundle author, but the same containment guarantee applies.
      lines.push(wrapContained("app-custom-instructions", app.customInstructions));
    }
  }
  lines.push(
    "",
    "When you create or modify data in apps that have a UI, mention that the user can view the result in the sidebar.",
  );
  if (hasProxiedTools) {
    lines.push(
      "",
      '**Important:** These apps have tools that are not in your direct tool list. Call `nb__search` with `scope: "tools"` and a keyword (e.g., "contact", "invoice", "document") to discover them — the top matches are **activated automatically** and callable on the next turn. Use `nb__manage_tools` only to activate a different match from the results, or to remove tools when switching domains (`{ "add": [...], "remove": [...] }`). Tool names use the format `source__tool` (e.g., `synapse-crm__create_contact`). Never guess tool names — always discover them first.',
    );
  }
  return lines.join("\n");
}

const INTERACTION_RULES = `### Interaction Rules

- When the user describes a change, identify which tool achieves it and call it directly. Do not ask for confirmation unless the action is destructive or ambiguous.
- After making changes, briefly confirm what you did. The app view refreshes automatically — do not describe the UI.
- If unsure which tool to use, call \`nb__search\` with \`scope: "tools"\` and a keyword. Its top matches are activated automatically — call them directly. Only use \`nb__manage_tools\` to activate a different match from the results, or to remove tools when clearly switching domains (batch removes with the next adds).
- When the user says "undo" or "go back," check if the app has undo, snapshot, or history tools. If not, say undo is not available for this app.
- When the user gives vague feedback ("I don't like it," "make it better"), ask ONE clarifying question about what specifically to change.
- Messages may include an \`[App Context: ...]\` header with metadata from the app. Use it to understand what the user was looking at.
- Other apps are still available via \`nb__search\` (scope: "tools") if the user's request spans apps; its top matches are auto-activated, so you can usually call them directly.`;

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
    lines.push(wrapContained("app-guide", focusedApp.skillResource));
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

  return `## Current App State\nLast updated: ${appState.updatedAt}\n\n${wrapContained("app-state", inner)}`;
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
  const tag: ContainmentTag =
    heading === "Organization Instructions" ? "org-instructions" : "workspace-instructions";
  return `## ${heading}\n\n${wrapContained(tag, body)}`;
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
    const provenance = `_${safeName}_ — scope: ${safeScope}; loaded: ${entry.loadedBy} (${safeReason})`;
    blocks.push(`### ${safeName}\n\n${provenance}\n\n${wrapContained("layer3-skill", entry.body)}`);
  }
  if (blocks.length === 0) return null;
  return `## Skills\n\n${blocks.join("\n\n")}`;
}

/**
 * Wrap a connector-skill overlay body for surfacing into the conversation
 * history. Unlike Layer-3 skills, a connector overlay NEVER enters the
 * cached system prefix — it becomes the body of a synthetic assistant message
 * the reconstructor emits on the first matching connector tool call, so the
 * guidance rides the append-only history rather than re-varying the prompt
 * prefix every turn.
 *
 * Containment is the same per-prompt defense `formatLayer3SkillsSection`
 * applies (bundle trust is install-time; this is the per-prompt guard): the
 * body is wrapped in `<connector-skill>` and any literal closing tag inside it
 * is rewritten to `&lt;/connector-skill>` so an overlay author can't break out
 * of containment. Name/scope ride a sanitized provenance line.
 */
export function formatConnectorSkillBlock(name: string, scope: string, body: string): string {
  const safeName = sanitizeLineField(name);
  const safeScope = sanitizeLineField(scope);
  const provenance = `_${safeName}_ — scope: ${safeScope}; surfaced on first matching connector tool call`;
  return `${provenance}\n\n${wrapContained("connector-skill", body)}`;
}

/**
 * Workspace-scoping applies to TOOLS, not to files or conversations. Both
 * workspace blocks narrate that a session reaches one workspace's tools (more
 * within that workspace are found with `nb__search`); without an explicit
 * counter-statement an agent overgeneralises
 * that model onto files and asks the user "which workspace does this file live
 * in?" — a real failure observed in production. Files and conversations are
 * identity-owned (one store at `users/{userId}/files/`, regardless of
 * workspace), so the always-loaded `files__*`/`conversations__*` tools already
 * see all of them. State that plainly in both blocks.
 */
const IDENTITY_SCOPE_NOTE =
  "Files and conversations are NOT workspace-scoped — they're identity-owned and the same in every workspace. The `files__*` and `conversations__*` tools are always loaded and search across all of your files/conversations at once. Never ask the user which workspace a file lives in, and don't use `nb__search` to find files — just call `files__search`/`files__list`.";

function formatWorkspaceContext(ws: WorkspaceContext): string {
  const lines = ["## Workspace", ""];
  lines.push(`- ID: ${sanitizeLineField(ws.id)}`);
  if (ws.name) lines.push(`- Name: ${sanitizeLineField(ws.name)}`);
  lines.push("");
  lines.push(
    "Your active tools are this workspace's — its apps plus the platform tools. This session reaches **only this workspace**: the user's OTHER workspaces, and their personal tools (e.g. email), are not reachable from here. If this workspace has more tools than are active right now, find them with `nb__search` — it searches THIS workspace and activates matches on demand, so search before assuming a tool is missing. If the user needs a tool that lives in a different workspace, tell them to switch to that workspace.",
  );
  lines.push("");
  lines.push(IDENTITY_SCOPE_NOTE);
  return lines.join("\n");
}

/**
 * Workspace block for the identity-level home (no focused workspace). States
 * plainly that there is no current workspace, so the agent answers "which
 * workspace am I in?" from context instead of calling a workspace-namespaced
 * tool and reporting an arbitrary one — and tells the agent that a specific
 * workspace's tools require opening that workspace (the home session can't
 * reach into them).
 */
function formatNoWorkspaceContext(): string {
  return [
    "## Workspace",
    "",
    "The user is at their identity-level home — **not in any single workspace**. There is no current workspace. If the user asks which workspace they're in, tell them they're at their home view, not a specific one.",
    "",
    "Your active tools are your personal workspace's — its apps plus the platform tools. A specific workspace's apps and tools are **not reachable from the home view**: to use them, the user must open that workspace. `nb__search` here searches only your personal workspace — it does not reach into other workspaces, so it won't surface a workspace's apps.",
    "",
    IDENTITY_SCOPE_NOTE,
  ].join("\n");
}

/**
 * User identity (name / timezone / locale) — STABLE across a session, so it
 * lives in the cached system prefix. Returns "" when no identity fields are set
 * (the caller then emits no `## User` section).
 */
function formatUserIdentity(prefs?: UserPrefs): string {
  const lines: string[] = [];
  if (prefs?.displayName) lines.push(`- Name: ${sanitizeLineField(prefs.displayName)}`);
  if (prefs?.timezone) lines.push(`- Timezone: ${sanitizeLineField(prefs.timezone)}`);
  if (prefs?.locale && prefs.locale !== "en-US")
    lines.push(`- Locale: ${sanitizeLineField(prefs.locale)}`);
  if (lines.length === 0) return "";
  return `## User\n\n${lines.join("\n")}`;
}

/**
 * Current date — VOLATILE (changes every turn), so it rides the latest user
 * message rather than the cached system block. Always emitted so the model
 * knows "today"; formatted in the user's timezone when it's valid.
 */
function formatCurrentDate(prefs?: UserPrefs): string {
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
  return `## Current Date\n\n- Today's date: ${formatted}`;
}
