import { ORG_ADMIN_ROLES, type OrgRole } from "../identity/types.ts";

/**
 * Feature flags for controlling which capabilities are available.
 * Most flags default to true for backward compatibility.
 *
 * Opt-in flags (default false) are documented inline.
 */
export interface FeatureFlags {
  /**
   * Reserved. Gated conversational bundle install/uninstall/configure via
   * `nb__manage_app`, which was removed (install/configure now live in the
   * Apps catalog + CLI). Kept as a stable operator config knob for the
   * bundle-management tool the delegation model contemplates reintroducing
   * (single tool, explicit workspace param, per-call admin auth).
   */
  bundleManagement?: boolean;
  skillManagement?: boolean;
  delegation?: boolean;
  toolDiscovery?: boolean;
  bundleDiscovery?: boolean;
  fileContext?: boolean;
  userManagement?: boolean;
  workspaceManagement?: boolean;
  /**
   * Opt-in (default false). When on, long conversations are compacted at run
   * start — the oldest turns folded into a summary — to bound context growth
   * without per-turn cache thrash. Event-sourced stores only. See
   * `conversation/compaction.ts`.
   */
  compaction?: boolean;
  /**
   * Default true (the Stage-2 ambient behavior). When `false`, a session's
   * tool composition AND invocation are locked to the FOCUSED workspace plus
   * the user's personal workspace (and the bare identity sources) — the
   * cross-workspace membership union is no longer surfaced (`nb__search`
   * corpus, the engine's promotable set) or callable (`routeToolCall`'s
   * focus-gate). Cross-workspace reach becomes a sequential focus-switch, not
   * an ambient union. Identity authorizes which workspaces may be focused;
   * focus composes the tools. Flip per-tenant to lock down; the default moves
   * once validated. See the workspace-lockdown design.
   */
  crossWorkspaceTools?: boolean;
}

/** Resolved feature flags — all required booleans (no optionals). */
export type ResolvedFeatures = Required<FeatureFlags>;

const DEFAULTS: ResolvedFeatures = {
  bundleManagement: true,
  skillManagement: true,
  delegation: true,
  toolDiscovery: true,
  bundleDiscovery: true,
  fileContext: true,
  userManagement: true,
  workspaceManagement: true,
  compaction: false,
  crossWorkspaceTools: true,
};

/** Resolve partial feature flags to a complete set. Missing keys default to true. */
export function resolveFeatures(config?: FeatureFlags): ResolvedFeatures {
  if (!config) return { ...DEFAULTS };
  return {
    bundleManagement: config.bundleManagement ?? true,
    skillManagement: config.skillManagement ?? true,
    delegation: config.delegation ?? true,
    toolDiscovery: config.toolDiscovery ?? true,
    bundleDiscovery: config.bundleDiscovery ?? true,
    fileContext: config.fileContext ?? true,
    userManagement: config.userManagement ?? true,
    workspaceManagement: config.workspaceManagement ?? true,
    compaction: config.compaction ?? false,
    crossWorkspaceTools: config.crossWorkspaceTools ?? true,
  };
}

/**
 * Maps tool names to the feature flag that controls them.
 * Both prefixed (nb__) and unprefixed names are included.
 * Tools NOT in this map (e.g., status) are always enabled.
 */
export const FEATURE_TOOL_MAP: Record<string, keyof FeatureFlags> = {
  // Prefixed names (as seen by the LLM / MCP clients)
  nb__delegate: "delegation",
  // Identity & workspace tools
  nb__manage_users: "userManagement",
  nb__manage_workspaces: "workspaceManagement",
  // Skill mutation surface — all five gated by `skillManagement`.
  skills__create: "skillManagement",
  skills__update: "skillManagement",
  skills__delete: "skillManagement",
  skills__activate: "skillManagement",
  skills__deactivate: "skillManagement",
  // Unprefixed names (used during system tool registration)
  delegate: "delegation",
  manage_users: "userManagement",
  manage_workspaces: "workspaceManagement",
};

/**
 * Check if a tool is enabled given the resolved features.
 * Tools not in FEATURE_TOOL_MAP are always enabled (e.g., status).
 */
export function isToolEnabled(toolName: string, features: ResolvedFeatures): boolean {
  const flag = FEATURE_TOOL_MAP[toolName];
  if (!flag) return true;
  return features[flag];
}

// ── Role-based tool visibility ───────────────────────────────────────

/**
 * Tools that require org-level admin or owner to be visible.
 * Non-admin users should never see these tools in the tool list.
 * Both prefixed and unprefixed names are included.
 */
const ADMIN_ONLY_TOOLS = new Set([
  "nb__manage_workspaces",
  "nb__manage_users",
  "nb__set_model_config",
  "manage_workspaces",
  "manage_users",
  "set_model_config",
]);

/**
 * Check if a tool should be visible to a user based on their org role.
 * Tools not in ADMIN_ONLY_TOOLS are visible to everyone.
 * Returns false when an admin-only tool is accessed by a non-admin (or unauthenticated) user.
 */
export function isToolVisibleToRole(toolName: string, orgRole: string | null | undefined): boolean {
  if (!ADMIN_ONLY_TOOLS.has(toolName)) return true;
  // orgRole arrives as a free string from web/API callers; the OrgRole-typed
  // set needs the narrowing. A non-OrgRole string just misses and returns false.
  return orgRole != null && ORG_ADMIN_ROLES.has(orgRole as OrgRole);
}
