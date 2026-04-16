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
 * Each entry maps a prefixed tool name to the feature flag that controls it.
 */
const PRIVILEGE_CANDIDATES: Array<{ tool: string; feature: keyof ResolvedFeatures }> = [
  { tool: "nb__manage_app", feature: "bundleManagement" },
  { tool: "nb__manage_skill", feature: "skillManagement" },
];

/**
 * Build the set of privileged tools, only including those whose feature is enabled.
 * Disabled features mean the tool doesn't exist — no need to gate it.
 */
function buildPrivilegedTools(features?: ResolvedFeatures): Set<string> {
  if (!features) {
    return new Set(PRIVILEGE_CANDIDATES.map((c) => c.tool));
  }
  return new Set(PRIVILEGE_CANDIDATES.filter((c) => features[c.feature]).map((c) => c.tool));
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
    if (!privilegedTools.has(call.name)) return call;
    const approved = await gate.confirm(`${call.input.action} ${call.input.name}?`, call.input);
    if (!approved) {
      eventSink.emit({
        type: "audit.permission_denied",
        data: { tool: call.name, action: call.input.action, target: call.input.name },
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
