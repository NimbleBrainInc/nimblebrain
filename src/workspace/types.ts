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
}
