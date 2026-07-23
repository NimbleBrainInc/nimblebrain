/**
 * Shared display helpers for skill provenance — used by the Context Ledger
 * line and the "In context" popover so both derive names, reasons, and scope
 * colors identically.
 */

import type { SkillScope } from "../_generated/platform-schemas/skills";

/**
 * Human-facing skill name from an id. Filesystem ids end in `/<name>.md`;
 * URI ids look like `skill://owner/<name>`. Either way the last path segment
 * (minus any `.md`) is the name.
 */
export function shortSkillName(id: string): string {
  const slash = id.lastIndexOf("/");
  const tail = slash >= 0 ? id.slice(slash + 1) : id;
  return tail.replace(/\.md$/, "");
}

/**
 * Strip the leading mechanism word from a load reason for the compact ledger
 * head — `tool-affinity matched mpak__*` → `matched mpak__*`,
 * `trigger matched "deploy"` → `matched "deploy"`, `always-on` unchanged. The
 * full verbatim reason still shows in the drawer.
 */
export function conciseReason(reason: string): string {
  return reason.replace(/^(tool-affinity|trigger)\s+/, "");
}

/** Token-driven scope color class (defined in index.css; no raw palette values). */
export const SCOPE_CLASS: Record<SkillScope, string> = {
  org: "ledger-scope--org",
  workspace: "ledger-scope--workspace",
  user: "ledger-scope--user",
  bundle: "ledger-scope--bundle",
};

/** `1234` → `1.2k`, `610` → `610`. Compact token count for dense rows. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}
