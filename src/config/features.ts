/**
 * Feature flags for controlling which capabilities are available.
 * Most flags default to true for backward compatibility.
 *
 * Opt-in flags (default false) are documented inline.
 */
export interface FeatureFlags {
  bundleManagement?: boolean;
  skillManagement?: boolean;
  delegation?: boolean;
  toolDiscovery?: boolean;
  bundleDiscovery?: boolean;
  mcpServer?: boolean;
  fileContext?: boolean;
  userManagement?: boolean;
  workspaceManagement?: boolean;
}

/** Resolved feature flags — all required booleans (no optionals). */
export type ResolvedFeatures = Required<FeatureFlags>;

const DEFAULTS: ResolvedFeatures = {
  bundleManagement: true,
  skillManagement: true,
  delegation: true,
  toolDiscovery: true,
  bundleDiscovery: true,
  mcpServer: true,
  fileContext: true,
  userManagement: true,
  workspaceManagement: true,
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
    mcpServer: config.mcpServer ?? true,
    fileContext: config.fileContext ?? true,
    userManagement: config.userManagement ?? true,
    workspaceManagement: config.workspaceManagement ?? true,
  };
}

/**
 * Maps tool names to the feature flag that controls them.
 * Both prefixed (nb__) and unprefixed names are included.
 * Tools NOT in this map (e.g., status) are always enabled.
 */
export const FEATURE_TOOL_MAP: Record<string, keyof FeatureFlags> = {
  // Prefixed names (as seen by the LLM / MCP clients)
  nb__manage_app: "bundleManagement",
  nb__delegate: "delegation",
  // Identity & workspace tools
  nb__manage_users: "userManagement",
  nb__manage_workspaces: "workspaceManagement",
  // Skill mutation surface — all six gated by `skillManagement`.
  skills__create: "skillManagement",
  skills__update: "skillManagement",
  skills__delete: "skillManagement",
  skills__activate: "skillManagement",
  skills__deactivate: "skillManagement",
  skills__move_scope: "skillManagement",
  // Unprefixed names (used during system tool registration)
  manage_app: "bundleManagement",
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
  return orgRole === "admin" || orgRole === "owner";
}
