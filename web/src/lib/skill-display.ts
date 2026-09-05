/**
 * Shared display helpers for skill provenance — used by the Context Ledger
 * line and the "In context" popover so both label reasons, provenance, and
 * scope colors identically.
 *
 * The runtime records each skill's own name on the `skills.loaded` event and
 * both read paths resolve it, so a display surface renders `skill.name`
 * directly rather than picking a name out of the id — doing that is what
 * rendered every connector skill as `SKILL` (a connector skill's id is its
 * `skill://…/SKILL.md` entrypoint). `nameFromSkillId` below is the normalizer's
 * last-resort guard for a frame that arrives without one, NOT a display path.
 */

import type { SkillScope } from "../_generated/platform-schemas/skills";

/**
 * A name from a skill id, for a stream frame that arrived without one.
 *
 * The normalizer in `chat-store` needs *some* string, and the id is a path
 * ending in `/SKILL.md` for every connector skill — printing it raw would put
 * the exact output this surface exists to eliminate back on screen. Mirrors
 * `src/skills/display-name.ts`; the copy exists because the browser can't
 * import from `src/`.
 */
export function nameFromSkillId(id: string): string {
  const segments = id.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? id;
  if (/^SKILL\.md$/i.test(last) && segments.length >= 2) {
    return segments[segments.length - 2] ?? last;
  }
  return last.replace(/\.md$/i, "");
}

/**
 * Strip the leading mechanism word from a load reason for the compact ledger
 * head — `tool-affinity matched docs__*` → `matched docs__*`,
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
  toolAffinity?: string[];
  triggers?: string[];
}

/**
 * Resting mechanism line for a catalog row, in the ledger's vocabulary
 * ("Using …" in chat; "Always on / On tool match / On trigger" here).
 *
 * `loading` is derived server-side by `resolveLoadingMechanism` and is the
 * only input trusted here — re-deriving it from `loadingStrategy`/affinity/
 * triggers in the web tier would be a second, drift-prone copy of that
 * predicate. `skills__list` populates it on every row, so `null` (caller
 * renders no line) means genuinely unknown, never "won't load".
 */
export function skillMechanismLabel(skill: SkillMechanismInput): SkillMechanismLabel | null {
  switch (skill.loading?.mechanism) {
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
    case "none":
      return { text: "Won't auto-load yet" };
    default:
      return null;
  }
}

/** Token-driven scope color class (defined in index.css; no raw palette values). */
export const SCOPE_CLASS: Record<SkillScope, string> = {
  org: "ledger-scope--org",
  workspace: "ledger-scope--workspace",
  user: "ledger-scope--user",
  bundle: "ledger-scope--connector",
};

/**
 * What a reader is shown for a skill's tier.
 *
 * The wire value stays `bundle` because it is persisted on every recorded
 * `skills.loaded` event; "connector" is the term the industry settled on for an
 * MCP server, and in this telemetry that is exactly what the tier means (the
 * platform's own vendored skills are excluded from the event upstream, by
 * `collectLoadedSkills`). Note Settings → Skills reads the SAME enum value with
 * a different meaning — there it is the built-in authoring guide, labelled
 * "System" — so this map is per-surface, not a global rename.
 */
export const SCOPE_LABEL: Record<SkillScope, string> = {
  org: "org",
  workspace: "workspace",
  user: "user",
  bundle: "connector",
};

/** The subset of a ledger skill that identifies where it came from. */
export interface SkillProvenanceInput {
  scope: SkillScope;
  connector?: string;
}

/**
 * Where a skill came from, in one word: the publishing connector when there is
 * one, otherwise its tier. Connector guidance is conventionally named for its
 * job (`usage`, `workflows`), so several connectors' skills collide by name in
 * a list — the publisher is what tells them apart.
 */
export function skillProvenanceLabel(skill: SkillProvenanceInput): string {
  return skill.connector ?? SCOPE_LABEL[skill.scope];
}

/** Heading for a group of skills that loaded by the same mechanism. */
export const MECHANISM_LABEL: Record<string, string> = {
  always: "Always on",
  tool_affinity: "Matched your tools",
  trigger: "Matched what you said",
};

/** Mechanisms in the order they are shown: unconditional first, then matched. */
const MECHANISM_ORDER = ["always", "tool_affinity", "trigger"];

/**
 * Group skills by why they loaded, so a list answers that once per group rather
 * than repeating a reason string on every row (or, as before, never). Preserves
 * input order within a group; unknown mechanisms sort last under their own raw
 * key, so a future mechanism appears rather than vanishing.
 */
export function groupByMechanism<T extends { loadedBy: string }>(
  skills: readonly T[],
): Array<{ mechanism: string; label: string; skills: T[] }> {
  const groups = new Map<string, T[]>();
  for (const skill of skills) {
    const existing = groups.get(skill.loadedBy);
    if (existing) existing.push(skill);
    else groups.set(skill.loadedBy, [skill]);
  }
  const rank = (m: string) => {
    const i = MECHANISM_ORDER.indexOf(m);
    return i === -1 ? MECHANISM_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([mechanism, grouped]) => ({
      mechanism,
      label: MECHANISM_LABEL[mechanism] ?? mechanism,
      skills: grouped,
    }));
}

/** `1234` → `1.2k`, `610` → `610`. Compact token count for dense rows. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}
