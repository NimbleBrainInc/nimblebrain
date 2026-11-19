/**
 * Shared display helpers for skill provenance — used by the Context Ledger
 * line and the "In context" popover so both label reasons, provenance, and
 * scope colors identically.
 *
 * The runtime records each skill's own name on the `skills.loaded` event, so a
 * display surface renders `skill.name` directly rather than picking a name out
 * of the id — doing that is what rendered every connector skill as `SKILL` (a
 * connector skill's id is its `skill://…/SKILL.md` entrypoint).
 * `nameFromSkillId` below is for what carries no name: a stream frame that
 * arrives without one, and a traced prompt layer, which records only its path.
 */

import type { Plugin } from "../_generated/platform-schemas/plugins";
import type { SkillScope } from "../_generated/platform-schemas/skills";
import { pluginsForToolPattern } from "./plugin-attribution";

/**
 * A name from a skill id, for something that carries only the id.
 *
 * The id is a path ending in `/SKILL.md` for every connector skill — printing
 * it raw would put the exact output this surface exists to eliminate back on
 * screen — so the entrypoint marker names its directory instead.
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
 * discriminator shown without expanding a row.
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
  loading?: { mechanism: "always" | "tool_affinity" | "trigger" | "on_request" };
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
    case "on_request":
      return { text: "When the agent asks for it" };
    default:
      return null;
  }
}

/**
 * When a skill loads, in the reader's words, for the Skills list and a skill's
 * page: "Always on", `On trigger "deploy"`, or "When Google Calendar is used".
 *
 * A tool pattern is internal (`my_gmail__*`), so it is named by the plugin it
 * reaches, through the same listing chat labels use: "When A or B is used" for
 * several, and "a matching tool" for a pattern no plugin answers. The pattern
 * itself shows only in the skill page's loading details (`skillLoadingSentence`).
 *
 * The default, loading when the agent asks for it, says nothing a list needs,
 * so it is `null` unless `includeDefault` asks for it (a skill's own page).
 */
export function skillLoadsText(
  skill: SkillMechanismInput,
  plugins: readonly Plugin[],
  { includeDefault = false }: { includeDefault?: boolean } = {},
): string | null {
  switch (skill.loading?.mechanism) {
    case "always":
      return "Always on";
    case "trigger": {
      const phrases = (skill.triggers ?? []).filter(Boolean);
      return phrases.length > 0
        ? `On trigger ${phrases.map((p) => `"${p}"`).join(", ")}`
        : "On trigger";
    }
    case "tool_affinity":
      return whenToolsUsed(skill.toolAffinity ?? [], plugins);
    case "on_request":
      return includeDefault ? "When the agent asks for it" : null;
    default:
      return null;
  }
}

/** "When A is used", "When A or B is used", "When A, B or C is used". */
export function whenUsedText(names: readonly string[]): string {
  return `When ${orList(names)} is used`;
}

function whenToolsUsed(patterns: readonly string[], plugins: readonly Plugin[]): string {
  return whenUsedText(toolPatternNames(patterns, plugins));
}

/** "A", "A or B", "A, B or C". */
function orList(names: readonly string[]): string {
  const rest = [...names];
  const last = rest.pop() ?? "";
  return rest.length === 0 ? last : `${rest.join(", ")} or ${last}`;
}

/**
 * The reader's names for what a skill's tool patterns reach, without repeats.
 * A pattern is named by the plugin it reaches (`pluginsForToolPattern`); on a
 * plugin's own page (`own`), a pattern over that plugin's servers is named by
 * the tool it names, or as the plugin's tools when it names them all. A
 * pattern nothing answers reads "a matching tool".
 */
function toolPatternNames(
  patterns: readonly string[],
  plugins: readonly Plugin[],
  own: readonly string[] = [],
): string[] {
  const names: string[] = [];
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  let unresolved = false;
  for (const pattern of patterns.filter(Boolean)) {
    const ownName = ownToolName(pattern, own);
    if (ownName) {
      add(ownName);
      continue;
    }
    const matched = pluginsForToolPattern(pattern, plugins);
    if (matched.length === 0) unresolved = true;
    for (const p of matched) add(p.displayName);
  }
  if (unresolved || names.length === 0) add("a matching tool");
  return names;
}

const OWN_TOOLS = "this plugin's tools";

/**
 * How a pattern over one of `own` servers reads on that plugin's page: the
 * tool part (`web_search`) when it names one, or the plugin's tools when it is
 * only a wildcard. Undefined for a pattern over any other source.
 */
function ownToolName(pattern: string, own: readonly string[]): string | undefined {
  const sep = pattern.indexOf("__");
  if (sep < 0 || !own.includes(pattern.slice(0, sep))) return undefined;
  const tool = pattern.slice(sep + 2);
  return !tool || /^\*+$/.test(tool) ? OWN_TOOLS : tool;
}

/**
 * When a plugin's skill loads, on the plugin's own page, whose `servers` are
 * this plugin's. A skill's tool patterns are prefixed with its own server's
 * name, so a tool-bound skill names the tools it waits for by their
 * short names ("When web_search or web_fetch is used"), or "When this
 * plugin's tools are used" when it waits for all of them. An overlay is
 * delivered on the first call to a tool it is bound to. Any other mechanism
 * reads as it does in the Skills list (`skillLoadsText`).
 */
export function pluginSkillLoadsText(
  skill: SkillMechanismInput & { overlay?: boolean },
  servers: readonly string[],
): string | null {
  if (skill.overlay || skill.loading?.mechanism === "tool_affinity") {
    const names = toolPatternNames(skill.toolAffinity ?? [], [], servers);
    const list = orList(names);
    if (skill.overlay) {
      return `On the first call to ${names.length === 1 && names[0] === OWN_TOOLS ? `one of ${OWN_TOOLS}` : list}`;
    }
    return names.length === 1 && names[0] === OWN_TOOLS
      ? `When ${OWN_TOOLS} are used`
      : `When ${list} is used`;
  }
  return skillLoadsText(skill, [], { includeDefault: true });
}

/**
 * The full sentence form of a loading mechanism, for the authoring editor.
 *
 * `skillMechanismLabel` above is the catalog row's compact grammar; this one
 * answers the question the editor is actually being asked — *when will this
 * skill reach the agent, and on what?* — so it names the signal. Both read the same
 * mechanism value, so the two surfaces cannot disagree about the verdict, only
 * about how much room they have to say it.
 */
export function skillLoadingSentence(
  mechanism: "always" | "tool_affinity" | "trigger" | "on_request",
  signals: { toolAffinity?: string[]; triggers?: string[] },
): { text: string; mono?: string } {
  switch (mechanism) {
    case "always":
      return { text: "Loads on every turn — the agent reads it in every conversation." };
    case "tool_affinity": {
      const globs = (signals.toolAffinity ?? []).filter(Boolean);
      return { text: "Loads when an active tool matches", mono: globs.join(", ") };
    }
    case "trigger": {
      const phrases = (signals.triggers ?? []).filter(Boolean);
      return { text: `Loads on ${phrases.map((p) => `"${p}"`).join(", ")}` };
    }
    case "on_request":
      return {
        text:
          "Loads when the agent asks for it. The agent sees its description in the skill " +
          "catalog; add a tool pattern or a trigger phrase to load it without being asked.",
      };
  }
}

/**
 * A map with an entry for every tier this build knows, read by the recorded
 * tier string. A recorded row can name a tier outside the union (see
 * `skillProvenanceLabel`), so a lookup may miss and callers fall back.
 */
type ScopeMap = Readonly<Record<string, string | undefined>>;

/** Token-driven scope color class (defined in index.css; no raw palette values). */
export const SCOPE_CLASS: ScopeMap = {
  org: "ledger-scope--org",
  workspace: "ledger-scope--workspace",
  user: "ledger-scope--user",
  provided: "ledger-scope--connector",
} satisfies Record<SkillScope, string>;

/**
 * What a reader is shown for a skill's tier.
 *
 * The wire value names the tier a skill is stored in (ADR-0034); the label
 * names what that tier means on THIS surface. In the ledger, `provided` can
 * only be a connector's own guidance — the platform's vendored skills are
 * excluded from the event upstream, by `collectLoadedSkills` — so it reads
 * "connector". Settings → Skills reads the same value where it CAN be the
 * built-in authoring guide, and labels it "System". The map is per-surface for
 * that reason, not because either label is the wire value's real name.
 */
export const SCOPE_LABEL: ScopeMap = {
  org: "org",
  workspace: "workspace",
  user: "user",
  provided: "connector",
} satisfies Record<SkillScope, string>;

/** The subset of a ledger skill that identifies where it came from. */
export interface SkillProvenanceInput {
  /** The recorded tier: a `SkillScope`, or a tier name an older run recorded. */
  scope: string;
  connector?: string;
}

/**
 * Where a skill came from, in one word: the publishing connector when there is
 * one, otherwise its tier. Connector guidance is conventionally named for its
 * job (`usage`, `workflows`), so several connectors' skills collide by name in
 * a list — the publisher is what tells them apart.
 */
export function skillProvenanceLabel(skill: SkillProvenanceInput): string {
  // A ledger row is a projection of a recorded event, and a record may hold a
  // tier this build's union does not list — the runtime never rewrites history
  // to match a later vocabulary (ADR-0034). Fall back to the stored string so a
  // historical row reads as what it was, rather than as a blank.
  return skill.connector ?? SCOPE_LABEL[skill.scope] ?? skill.scope;
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
