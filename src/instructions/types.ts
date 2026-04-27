/**
 * Platform-owned overlay storage types.
 *
 * Two scopes only — `org` and `workspace`. Per-bundle instructions are NOT
 * platform-owned: bundles publish a `<sourceName>://instructions` resource
 * if and only if they want to support custom instructions, and store them
 * in their own data dir. The platform reads that resource on every prompt
 * assembly and wraps it in `<app-custom-instructions>` containment — but
 * the storage and tool authoring stay bundle-side.
 *
 * Org is slot-reserved (Phase 3 home TBD). Workspace ships in Phase 1's
 * rework via the workspace detail page.
 */

export type Scope = "org" | "workspace";

export type UpdatedBy = "agent" | "ui";

/** Sibling-file metadata recorded alongside each instructions file. */
export interface InstructionsMeta {
  updated_at: string;
  updated_by: UpdatedBy;
}

export interface ReadOptions {
  scope: Scope;
  /** Required for `workspace` scope; ignored for `org`. */
  wsId?: string;
}

export interface WriteOptions extends ReadOptions {
  text: string;
  updatedBy: UpdatedBy;
}

export interface WriteResult {
  updated_at: string;
}

/** Maximum allowed instruction body in bytes (UTF-8). */
export const MAX_INSTRUCTIONS_BYTES = 8 * 1024;
