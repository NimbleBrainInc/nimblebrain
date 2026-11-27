/**
 * The `workspaces` block of `nimblebrain.json`: how long a deleted workspace
 * can be restored before the runtime purges it.
 *
 * Deleting a workspace makes it a tombstone that every door refuses; after the
 * retention window the purge reconcile removes it, its plugins' records and the
 * kernel's own (`Runtime.purgeDeletedWorkspaces`). 0 purges at once.
 */

/** The `workspaces` block, as an operator writes it. */
export interface WorkspacesConfig {
  /** Days a deleted workspace can be restored before it is purged. 0 purges at once. */
  deletedRetentionDays?: number;
}

export type ResolvedWorkspacesConfig = Required<WorkspacesConfig>;

/** The window a deployment that sets none gets. */
export const DEFAULT_DELETED_RETENTION_DAYS = 30;

/** The range `deletedRetentionDays` is clamped to. */
export const WORKSPACES_CONFIG_BOUNDS: Record<
  keyof WorkspacesConfig,
  { min: number; max: number }
> = {
  deletedRetentionDays: { min: 0, max: 3650 },
};

/** Every key of the block, for the schema drift guard. */
export const WORKSPACES_CONFIG_KEYS = Object.keys(
  WORKSPACES_CONFIG_BOUNDS,
) as (keyof WorkspacesConfig)[];

/**
 * Resolve the block, clamping into range. A value that is not a finite number
 * resolves to the default; the schema rejects one at load anyway.
 */
export function resolveWorkspacesConfig(config?: WorkspacesConfig): ResolvedWorkspacesConfig {
  const raw = config?.deletedRetentionDays;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { deletedRetentionDays: DEFAULT_DELETED_RETENTION_DAYS };
  }
  const { min, max } = WORKSPACES_CONFIG_BOUNDS.deletedRetentionDays;
  return { deletedRetentionDays: Math.min(Math.max(raw, min), max) };
}
