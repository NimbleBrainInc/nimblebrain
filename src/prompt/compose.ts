import type { ParticipantInfo } from "../conversation/types.ts";
import type { Skill } from "../skills/types.ts";

const SEPARATOR = "\n\n---\n\n";

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
  trustScore: number;
  ui: { name: string } | null;
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
  participants?: ParticipantInfo[],
  workspaceContext?: WorkspaceContext,
): string {
  const layers: string[] = [];

  // Separate core context (priority ≤ threshold) from user context (priority > threshold)
  const coreContext: Skill[] = [];
  const userContext: Skill[] = [];
  for (const ctx of contextSkills) {
    if (ctx.manifest.priority <= CORE_PRIORITY_THRESHOLD) {
      coreContext.push(ctx);
    } else {
      userContext.push(ctx);
    }
  }

  // Layer 0: Core context bodies (identity layer)
  for (const ctx of coreContext) {
    if (ctx.body) layers.push(ctx.body);
  }

  // Fallback to default identity if no core context skills produced content
  if (layers.length === 0) {
    layers.push(DEFAULT_IDENTITY);
  }

  // Layer 1: User context bodies
  for (const ctx of userContext) {
    if (ctx.body) layers.push(ctx.body);
  }

  // Layer 1.5: User preferences (name, timezone, locale) + current date
  layers.push(formatUserPrefs(userPrefs));

  // Layer 1.6: Participants section (shared conversations)
  if (participants && participants.length > 0) {
    layers.push(formatParticipantsSection(participants));
  }

  // Layer 1.7: Workspace context
  if (workspaceContext) {
    layers.push(formatWorkspaceContext(workspaceContext));
  }

  // Layer 2: Installed apps section (§7.3)
  if (apps && apps.length > 0) {
    layers.push(formatAppsSection(apps, hasProxiedTools));
  }

  // Layer 2.5: Active app state (Synapse Feature 2 — LLM-aware UI state)
  if (appState) {
    const stateSection = formatAppStateSection(appState);
    if (stateSection) layers.push(stateSection);
  }

  // Layer 3: Focused app section (between apps and matched skill)
  if (focusedApp) {
    layers.push(formatFocusedAppSection(focusedApp));
  }

  // Layer 4: Matched skill
  if (matchedSkill?.body)
    layers.push(`<skill-instructions>\n${matchedSkill.body}\n</skill-instructions>`);

  return layers.join(SEPARATOR);
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
  }
  lines.push(
    "",
    "When you create or modify data in apps that have a UI, mention that the user can view the result in the sidebar.",
  );
  if (hasProxiedTools) {
    lines.push(
      "",
      '**Important:** These apps have tools that are not in your direct tool list. To use an app\'s tools, call `nb__search` with `scope: "tools"` and a keyword (e.g., "contact", "invoice", "document") to discover the exact tool names. Tool names use the format `source__tool` (e.g., `synapse-crm__create_contact`). Never guess tool names — always discover them first.',
    );
  }
  return lines.join("\n");
}

const INTERACTION_RULES = `### Interaction Rules

- When the user describes a change, identify which tool achieves it and call it directly. Do not ask for confirmation unless the action is destructive or ambiguous.
- After making changes, briefly confirm what you did. The app view refreshes automatically — do not describe the UI.
- If unsure which tool to use, call \`nb__search\` with \`scope: "tools"\` and a keyword.
- When the user says "undo" or "go back," check if the app has undo, snapshot, or history tools. If not, say undo is not available for this app.
- When the user gives vague feedback ("I don't like it," "make it better"), ask ONE clarifying question about what specifically to change.
- Messages may include an \`[App Context: ...]\` header with metadata from the app. Use it to understand what the user was looking at.
- Other apps are still available via \`nb__search\` (scope: "tools") if the user's request spans apps.`;

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
  if (focusedApp.skillResource && focusedApp.trustScore >= 50) {
    lines.push(`<app-guide>\n${focusedApp.skillResource}\n</app-guide>`);
    if (focusedApp.referenceResourceUri) {
      lines.push("");
      lines.push(
        `For detailed tool guidance, error recovery, and reference material, read the \`${focusedApp.referenceResourceUri}\` resource.`,
      );
    }
  } else if (focusedApp.skillResource) {
    lines.push("App guide available but not injected — bundle trust score below threshold.");
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
 * Trust-gated: only apps with trustScore >= 50 get their state in the prompt.
 */
function formatAppStateSection(appState: AppStateInfo): string | null {
  // Trust gating: score must be >= 50
  if (appState.trustScore < 50) return null;

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

  return `## Current App State\nLast updated: ${appState.updatedAt}\n\n<app-state>\n${inner}\n</app-state>`;
}

function formatParticipantsSection(participants: ParticipantInfo[]): string {
  const lines = [
    "## Participants",
    "",
    "This is a shared conversation with the following participants:",
  ];
  for (const p of participants) {
    const safeName = p.displayName ? sanitizeLineField(p.displayName) : undefined;
    const label = safeName ? `${safeName} (${p.userId})` : p.userId;
    lines.push(`- ${label}`);
  }
  return lines.join("\n");
}

function formatWorkspaceContext(ws: WorkspaceContext): string {
  const lines = ["## Workspace", ""];
  lines.push(`- ID: ${sanitizeLineField(ws.id)}`);
  if (ws.name) lines.push(`- Name: ${sanitizeLineField(ws.name)}`);
  return lines.join("\n");
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
