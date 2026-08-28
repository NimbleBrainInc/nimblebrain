/**
 * Platform-owned overlay storage types.
 *
 * Workspace scope only. Org-wide standing guidance is an org-tier **skill**
 * (`{workDir}/skills/`, authored at `/org/skills`): same file-backed
 * determinism and the same org-admin write gate, plus per-topic granularity,
 * dynamic loading, and triggers. A second org-wide always-on channel bought
 * none of that.
 *
 * Per-bundle instructions are NOT platform-owned: bundles publish a
 * `<sourceName>://instructions` resource if and only if they want to support
 * custom instructions, and store them in their own data dir. The platform
 * reads that resource on every prompt assembly and wraps it in
 * `<app-custom-instructions>` containment — but the storage and tool authoring
 * stay bundle-side.
 */

export type UpdatedBy = "agent" | "ui";

/** Sibling-file metadata recorded alongside each instructions file. */
export interface InstructionsMeta {
  updated_at: string;
  updated_by: UpdatedBy;
}

export interface ReadOptions {
  wsId: string;
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
