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

/**
 * The resting-state description of how a skill reaches the prompt — the
 * discriminator the flat catalog used to hide until a row was expanded.
 * `text` is the plain lead; `mono` is an optional monospace tail (the tool
 * globs a `tool_affinity` skill matches), kept separate so the caller renders
 * it in mono without re-parsing the string.
 */
export interface SkillMechanismLabel {
  text: string;
  mono?: string;
}

/** The subset of a skill summary that determines its loading mechanism. */
export interface SkillMechanismInput {
  loading?: { mechanism: "always" | "tool_affinity" | "trigger" | "none" };
  loadingStrategy?: string;
  toolAffinity?: string[];
  triggers?: string[];
}

/**
 * Resting mechanism line for a catalog row, in the ledger's vocabulary
 * ("Following …" in chat; "Always on / On tool match / On trigger" here).
 * Falls back to `loadingStrategy` when the derived `loading` field is absent
 * (older list reads), and to the honesty state ("Won't auto-load yet") for a
 * skill no loader path reaches.
 */
export function skillMechanismLabel(skill: SkillMechanismInput): SkillMechanismLabel {
  const mechanism =
    skill.loading?.mechanism ?? (skill.loadingStrategy === "always" ? "always" : "none");
  switch (mechanism) {
    case "always":
      return { text: "Always on · every conversation" };
    case "tool_affinity": {
      const globs = (skill.toolAffinity ?? []).filter(Boolean);
      return globs.length > 0
        ? { text: "On tool match", mono: globs.join(", ") }
        : { text: "On tool match" };
    }
    case "trigger": {
      const phrases = (skill.triggers ?? []).filter(Boolean);
      return phrases.length > 0
        ? { text: `On trigger ${phrases.map((p) => `"${p}"`).join(", ")}` }
        : { text: "On trigger" };
    }
    default:
      return { text: "Won't auto-load yet" };
  }
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
