import type { EngineHooks, EventSink, ToolCall } from "../engine/types.ts";
import type { ResolvedFeatures } from "./features.ts";

/** Field descriptor from a bundle's user_config manifest section. */
export interface ConfigField {
  key: string;
  title?: string;
  description?: string;
  sensitive?: boolean;
  required?: boolean;
}

/** Gate for confirming privileged tool calls and prompting for config values. */
export interface ConfirmationGate {
  readonly supportsInteraction: boolean;

  /** Returns true if user approves, false to deny. */
  confirm(description: string, details: Record<string, unknown>): Promise<boolean>;

  /** Prompt for a bundle config value — masked if sensitive, saved via ConfigManager. */
  promptConfigValue(field: ConfigField): Promise<string | null>;
}

/**
 * All tools that require confirmation when enabled.
 *
 * Each entry maps a prefixed tool name to the feature flag that controls
 * it (so disabling the feature also stops gating attempts on a non-
 * existent tool) and a `describe` callback that renders the prompt the
 * user sees in the confirmation dialog.
 *
 * The set is small on purpose: only ops with persistent or destructive
 * effects make it here. Read tools and idempotent state changes don't
 * need confirmation. `skills__delete` and `skills__move_scope` qualify
 * because both can lose data (delete removes the live file, move_scope
 * replaces the source location's skill); `skills__update` does too,
 * but its versioning snapshot makes it trivially recoverable so we lean
 * on description-as-policy there.
 */
interface PrivilegeEntry {
  tool: string;
  feature: keyof ResolvedFeatures;
  describe: (input: Record<string, unknown>) => string;
}

const PRIVILEGE_CANDIDATES: PrivilegeEntry[] = [
  {
    tool: "nb__manage_app",
    feature: "bundleManagement",
    describe: (input) => `${input.action} ${input.name}?`,
  },
  {
    // Creates land in the prompt as soon as they're written (always-load
    // skills) or on the next applicable turn (tool_affined). Gating
    // matches the description-as-policy line "confirm before creating
    // platform-/workspace-scope skills" so the agent doesn't spawn
    // org-wide context unilaterally. Web-UI calls bypass the engine
    // hook (trusted same-origin), so this only fires for agent calls.
    tool: "skills__create",
    feature: "skillManagement",
    describe: (input) => `Create ${input.scope} skill "${input.name}"?`,
  },
  {
    tool: "skills__delete",
    feature: "skillManagement",
    describe: (input) => `Delete skill ${input.id}? Snapshots to _versions/ before removal.`,
  },
  {
    tool: "skills__move_scope",
    feature: "skillManagement",
    describe: (input) =>
      `Move skill ${input.id} to ${input.target_scope} scope? Source location is removed.`,
  },
];

/**
 * Build the set of privileged tool entries, only including those whose
 * feature is enabled. Disabled features mean the tool doesn't exist —
 * no need to gate it.
 */
function buildPrivilegedTools(features?: ResolvedFeatures): Map<string, PrivilegeEntry> {
  const candidates = features
    ? PRIVILEGE_CANDIDATES.filter((c) => features[c.feature])
    : PRIVILEGE_CANDIDATES;
  return new Map(candidates.map((c) => [c.tool, c]));
}

/**
 * Creates a beforeToolCall hook that gates privileged tools
 * through a ConfirmationGate. Non-privileged tools pass through.
 * Denied tools return null (skipped by engine).
 */
export function createPrivilegeHook(
  gate: ConfirmationGate,
  eventSink: EventSink,
  features?: ResolvedFeatures,
): NonNullable<EngineHooks["beforeToolCall"]> {
  const privilegedTools = buildPrivilegedTools(features);
  return async (call: ToolCall) => {
    const entry = privilegedTools.get(call.name);
    if (!entry) return call;
    const description = entry.describe(call.input);
    const approved = await gate.confirm(description, call.input);
    if (!approved) {
      // Derive `action` from `input.action` when present (legacy shape used
      // by `nb__manage_app`); otherwise fall back to the unprefixed tool
      // name (`delete`, `move_scope` etc.) so audit consumers always see
      // a non-empty action label.
      const action =
        typeof call.input.action === "string"
          ? call.input.action
          : (call.name.split("__").pop() ?? call.name);
      const target = call.input.name ?? call.input.id ?? null;
      eventSink.emit({
        type: "audit.permission_denied",
        data: { tool: call.name, action, target },
      });
    }
    return approved ? call : null;
  };
}

/** No-op gate that auto-approves everything. Used for non-interactive/test contexts. */
export class NoopConfirmationGate implements ConfirmationGate {
  readonly supportsInteraction = false;
  async confirm(): Promise<boolean> {
    return true;
  }
  async promptConfigValue(): Promise<string | null> {
    return null;
  }
}
