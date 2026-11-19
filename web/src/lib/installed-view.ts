import type { Plugin } from "../_generated/platform-schemas/plugins";
import type { AuthoredSkill } from "./authored-skills";
import { pluginAccount } from "./plugins";

/**
 * The Installed tab's model: what the agent can use in a workspace, arranged
 * by who it acts for, filtered by a search and the toolbar's two filters.
 * Pure, so the page's arrangement is tested without rendering it.
 *
 * Whose an item is follows ADR-0069 and the skill tiers: a workspace plugin, a
 * workspace skill and an org skill act for everyone here (**Shared**); a
 * person's plugin granted here and the viewer's own skills act only for the
 * viewer (**Just you**); a person's plugin not granted here acts nowhere here
 * (**Yours, not on here**).
 */

/** Who an item acts for here. */
export type ItemOwner = "shared" | "you";

/** The three sections, in page order. */
export type SectionId = "shared" | "you" | "not-here";

export type KindFilter = "all" | "plugins" | "skills";
export type OwnerFilter = "everyone" | "shared" | "you";

export interface InstalledFilters {
  query: string;
  kind: KindFilter;
  owner: OwnerFilter;
}

/**
 * The action a plugin's row asks of the viewer, when it asks one:
 *
 * - `connect`: on here and never signed in. Signing in clears it.
 * - `reconnect`: its sign-in expired.
 * - `open`: it failed or needs setup, which its page explains and fixes.
 *
 * A workspace plugin's sign-in is its admin's to do, so it asks a member
 * nothing. Connecting or starting asks nothing either: it is settling. A
 * person's plugin not on here asks Use here instead, which lives in its own
 * section rather than among what needs the viewer.
 */
export type AttentionStep = "connect" | "reconnect" | "open";

export function pluginAttention(
  plugin: Plugin,
  { canManage }: { canManage: boolean },
): AttentionStep | null {
  if (plugin.owner.kind === "person" && !plugin.granted) return null;
  const statuses = plugin.servers.map((s) => s.status);
  if (statuses.some((s) => s === "failed" || s === "needs_setup")) return "open";
  const mayConnect = plugin.owner.kind === "person" || canManage;
  if (!mayConnect) return null;
  if (statuses.includes("not_connected")) return "connect";
  if (statuses.includes("needs_auth")) return "reconnect";
  return null;
}

/** Why a plugin needs the viewer, in the words its Needs-you row uses. */
export function attentionReason(plugin: Plugin): string | undefined {
  const statuses = plugin.servers.map((s) => s.status);
  if (statuses.includes("failed")) return "Failed to start";
  if (statuses.includes("needs_setup")) return "Needs setup";
  if (statuses.includes("not_connected")) return "Not signed in";
  if (statuses.includes("needs_auth")) return "Sign-in expired";
  return undefined;
}

export function pluginOwner(plugin: Plugin): ItemOwner {
  return plugin.owner.kind === "workspace" ? "shared" : "you";
}

export function skillOwner(skill: AuthoredSkill): ItemOwner {
  return skill.scope === "user" ? "you" : "shared";
}

/** One item in a flat list (search results, Needs you), carrying whose it is. */
export type InstalledItem =
  | { kind: "plugin"; plugin: Plugin; owner: ItemOwner; attention: AttentionStep | null }
  | { kind: "skill"; skill: AuthoredSkill; owner: ItemOwner };

export interface SectionModel {
  id: SectionId;
  plugins: Plugin[];
  skills: AuthoredSkill[];
}

export interface InstalledModel {
  /** Plugins whose row asks an action, across sections. Empty while searching. */
  needsYou: Plugin[];
  /** Non-empty sections, in page order. Empty while searching. */
  sections: SectionModel[];
  /** While searching: every match, plugins then skills, ignoring sections. */
  results: InstalledItem[] | null;
  /** How many of each kind pass the search and the owner filter, for the kind control. */
  counts: { plugins: number; skills: number };
  /** Whether anything is installed at all, before any filter. */
  empty: boolean;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Words a plugin is found by: its name, its servers, and the account it signs in as. */
function pluginMatches(plugin: Plugin, terms: string[]): boolean {
  const haystack = [
    plugin.displayName,
    ...plugin.servers.map((s) => s.serverName),
    pluginAccount(plugin) ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/** Words a skill is found by: its name and what it is for. */
function skillMatches(skill: AuthoredSkill, terms: string[]): boolean {
  const haystack = `${skill.name} ${skill.description ?? ""}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function ownerPasses(owner: ItemOwner, filter: OwnerFilter): boolean {
  return filter === "everyone" || filter === owner;
}

/**
 * Arrange the listing. Within every list, plugins that need the viewer come
 * first, then all by name.
 */
export function buildInstalledModel(
  plugins: readonly Plugin[],
  skills: readonly AuthoredSkill[],
  filters: InstalledFilters,
  { canManage }: { canManage: boolean },
): InstalledModel {
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const attention = new Map(plugins.map((p) => [p.id, pluginAttention(p, { canManage })]));
  const pluginOrder = (a: Plugin, b: Plugin) =>
    Number(attention.get(a.id) === null) - Number(attention.get(b.id) === null) ||
    byName(a.displayName, b.displayName);

  const keptPlugins = plugins
    .filter((p) => ownerPasses(pluginOwner(p), filters.owner))
    .filter((p) => !searching || pluginMatches(p, terms))
    .sort(pluginOrder);
  const keptSkills = skills
    .filter((s) => ownerPasses(skillOwner(s), filters.owner))
    .filter((s) => !searching || skillMatches(s, terms))
    .sort((a, b) => byName(a.name, b.name));

  const counts = { plugins: keptPlugins.length, skills: keptSkills.length };
  const shownPlugins = filters.kind === "skills" ? [] : keptPlugins;
  const shownSkills = filters.kind === "plugins" ? [] : keptSkills;
  const empty = plugins.length === 0 && skills.length === 0;

  if (searching) {
    const results: InstalledItem[] = [
      ...shownPlugins.map(
        (plugin): InstalledItem => ({
          kind: "plugin",
          plugin,
          owner: pluginOwner(plugin),
          attention: attention.get(plugin.id) ?? null,
        }),
      ),
      ...shownSkills.map(
        (skill): InstalledItem => ({ kind: "skill", skill, owner: skillOwner(skill) }),
      ),
    ];
    return { needsYou: [], sections: [], results, counts, empty };
  }

  const sections: SectionModel[] = [
    {
      id: "shared",
      plugins: shownPlugins.filter((p) => p.owner.kind === "workspace"),
      skills: shownSkills.filter((s) => skillOwner(s) === "shared"),
    },
    {
      id: "you",
      plugins: shownPlugins.filter((p) => p.owner.kind === "person" && p.granted),
      skills: shownSkills.filter((s) => skillOwner(s) === "you"),
    },
    {
      id: "not-here",
      plugins: shownPlugins.filter((p) => p.owner.kind === "person" && !p.granted),
      skills: [],
    },
  ];
  return {
    needsYou: shownPlugins.filter((p) => attention.get(p.id) !== null),
    sections: sections.filter((s) => s.plugins.length + s.skills.length > 0),
    results: null,
    counts,
    empty,
  };
}

/** "34 plugins · 12 skills", leaving out a kind with none. */
export function countLine(plugins: number, skills: number): string {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (plugins > 0) parts.push(count(plugins, "plugin"));
  if (skills > 0) parts.push(count(skills, "skill"));
  return parts.join(" · ");
}

/** How many rows a section's sub-list shows before "Show all". */
export const SUBLIST_PREVIEW = 5;

/** Which sections start collapsed: only the viewer's plugins not on here. */
export const DEFAULT_COLLAPSED: Readonly<Record<SectionId, boolean>> = {
  shared: false,
  you: false,
  "not-here": true,
};

/**
 * The viewer's collapse choices, as overrides of `DEFAULT_COLLAPSED`. Parsed
 * from storage, so anything that is not a known section with a boolean is
 * dropped.
 */
export function parseCollapsed(stored: unknown): Partial<Record<SectionId, boolean>> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  const out: Partial<Record<SectionId, boolean>> = {};
  for (const id of ["shared", "you", "not-here"] as const) {
    const value = (stored as Record<string, unknown>)[id];
    if (typeof value === "boolean") out[id] = value;
  }
  return out;
}
