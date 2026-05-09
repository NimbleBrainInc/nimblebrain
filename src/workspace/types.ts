import type { BundleRef } from "../bundles/types.ts";
import type { AgentProfile, ModelSlots } from "../runtime/types.ts";

/** Workspace-level member roles. */
export type WorkspaceRole = "admin" | "member";

/** A user's membership in a workspace. */
export interface WorkspaceMember {
  userId: string;
  role: WorkspaceRole;
}

/** A workspace groups users and bundles. */
export interface Workspace {
  id: string;
  name: string;
  members: WorkspaceMember[];
  bundles: BundleRef[];
  createdAt: string;
  updatedAt: string;

  /** Named agent profiles for multi-agent delegation. */
  agents?: Record<string, AgentProfile>;
  /** Additional skill directories to scan. */
  skillDirs?: string[];
  /** Optional model slot overrides for this workspace. */
  models?: Partial<ModelSlots>;
  /** Optional markdown identity override for this workspace's agent persona. */
  identity?: string;
  /**
   * Allow bundles in this workspace to expose HTTP proxy routes (declared via
   * `_meta["ai.nimblebrain/http-proxy"]` in their manifests). Default true.
   * Set false to block all proxy routes in security-sensitive workspaces.
   */
  allowHttpProxy?: boolean;
  /**
   * Per-workspace catalog allow-list. When set, only catalog entries
   * whose `id` is in this array appear on the Connections page for
   * this workspace. When unset (default), the full loaded catalog is
   * visible. Useful for tenanted SaaS deployments that want to expose
   * different vendors to different customers without maintaining
   * separate catalog ConfigMaps.
   *
   * Filters the catalog only — does NOT affect bundles already
   * installed in `bundles[]` (those continue to function regardless of
   * allow-list state). Removing an id from the allow-list while a
   * bundle of the same name is installed is permitted; the bundle
   * stays running but won't appear in the catalog UI.
   */
  connectorsAllowList?: string[];

  /**
   * Per-workspace OAuth app configurations for static-auth catalog
   * entries. Keyed by catalog id (the reverse-DNS `ServerDetail.name`,
   * e.g. "io.asana/mcp"), the value carries the operator-supplied
   * public `client_id` plus an audit trail. The
   * matching `client_secret` lives in the workspace credential store
   * under the catalog entry's `operatorSetup.clientSecretKey` — kept
   * separate so the secret never sits next to non-secret config and
   * the type system isn't carrying a `Redacted` for what's a public id.
   *
   * Lifecycle is independent of bundle install: setting up an OAuth
   * app makes the connector installable for the whole workspace;
   * uninstalling the connector does NOT remove this config (so a
   * later re-install reuses it). Explicit removal goes through
   * `manage_connectors.remove_operator_setup`.
   */
  oauthOperatorApps?: Record<string, OAuthOperatorAppConfig>;
}

/** Per-workspace operator-supplied OAuth app credentials, public side. */
export interface OAuthOperatorAppConfig {
  /** OAuth client_id from the vendor's developer portal. */
  clientId: string;
  /** ISO timestamp of when the operator first configured this app. */
  configuredAt: string;
  /** User id of the operator who set this up — audit trail only. */
  configuredBy: string;
}
