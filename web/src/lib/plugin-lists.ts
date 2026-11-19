import type { Plugin, PluginSkill } from "../_generated/platform-schemas/plugins";
import type { AuthoredSkill } from "./authored-skills";
import { pluginAccount } from "./plugins";

/**
 * The models behind the Plugins and Skills pages: what each lists in a
 * segment, filtered by a search. Pure, so the arrangement is tested without
 * rendering it.
 *
 * Both pages split by whose an item is (ADR-0069 and the skill tiers).
 * **Workspace** is what acts for everyone here: the workspace's plugins, its
 * skills and the org's. **Personal** is the viewer's own: their plugins,
 * whether or not they are on here, and their skills.
 */
export type Segment = "workspace" | "personal";

/**
 * The action a plugin's row asks of the viewer, when it asks one:
 *
 * - `connect`: on here and never signed in. Signing in clears it.
 * - `reconnect`: its sign-in expired.
 * - `open`: it failed or needs setup, which its page explains and fixes.
 *
 * A workspace plugin's sign-in is its admin's to do, so it asks a member
 * nothing. Connecting or starting asks nothing either: it is settling. A
 * person's plugin not on here offers Use here instead, which is a choice, not
 * something that needs the viewer.
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

/** Why a plugin needs the viewer, as the Needs-you line says it. */
export function attentionReason(plugin: Plugin): string | undefined {
  const statuses = plugin.servers.map((s) => s.status);
  if (statuses.includes("failed")) return "failed to start";
  if (statuses.includes("needs_setup")) return "needs setup";
  if (statuses.includes("not_connected")) return "isn't signed in";
  if (statuses.includes("needs_auth")) return "needs you to sign in again";
  return undefined;
}

/** What is wrong, as a row says it when its action is offered elsewhere. */
export function attentionLabel(plugin: Plugin): string | undefined {
  const statuses = plugin.servers.map((s) => s.status);
  if (statuses.includes("failed")) return "Failed to start";
  if (statuses.includes("needs_setup")) return "Needs setup";
  if (statuses.includes("not_connected")) return "Not signed in";
  if (statuses.includes("needs_auth")) return "Sign-in expired";
  return undefined;
}

/**
 * The segment a page opens on until the viewer picks one: Workspace, unless
 * only Personal has anything, or `preferPersonal` (a sign-in just returned to
 * one of the viewer's own).
 */
export function defaultSegment(
  counts: Record<Segment, number> | null,
  preferPersonal = false,
): Segment {
  if (preferPersonal) return "personal";
  return counts && counts.workspace === 0 && counts.personal > 0 ? "personal" : "workspace";
}

export function pluginSegment(plugin: Plugin): Segment {
  return plugin.owner.kind === "workspace" ? "workspace" : "personal";
}

export function skillSegment(skill: AuthoredSkill): Segment {
  return skill.scope === "user" ? "personal" : "workspace";
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** A search's words, lowercased; none for an empty search. */
function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(haystack: string, terms: string[]): boolean {
  const text = haystack.toLowerCase();
  return terms.every((t) => text.includes(t));
}

/** Words a plugin is found by: its name, its servers, and the account it signs in as. */
function pluginText(plugin: Plugin): string {
  return [plugin.displayName, ...plugin.servers.map((s) => s.serverName), pluginAccount(plugin)]
    .filter(Boolean)
    .join(" ");
}

export interface PluginsModel {
  /** How many plugins each segment holds, before the search. */
  counts: Record<Segment, number>;
  /**
   * The segment's plugins that need the viewer, before the search: the
   * Needs-you line counts them whatever is typed.
   */
  needsYou: Plugin[];
  /**
   * The rows to list: the segment's plugins that match the search (and, with
   * `needsOnly`, need the viewer). Those that need the viewer come first, then
   * those on here, then by name.
   */
  rows: Plugin[];
}

export function buildPluginsModel(
  plugins: readonly Plugin[],
  opts: { segment: Segment; query: string; needsOnly?: boolean; canManage: boolean },
): PluginsModel {
  const terms = searchTerms(opts.query);
  const attention = new Map(plugins.map((p) => [p.id, pluginAttention(p, opts)]));
  const needs = (p: Plugin) => attention.get(p.id) !== null;
  const counts: Record<Segment, number> = { workspace: 0, personal: 0 };
  for (const p of plugins) counts[pluginSegment(p)] += 1;

  const inSegment = plugins.filter((p) => pluginSegment(p) === opts.segment);
  const rows = inSegment
    .filter((p) => !opts.needsOnly || needs(p))
    .filter((p) => matches(pluginText(p), terms))
    .sort(
      (a, b) =>
        Number(!needs(a)) - Number(!needs(b)) ||
        Number(!a.granted) - Number(!b.granted) ||
        byName(a.displayName, b.displayName),
    );
  return {
    counts,
    needsYou: inSegment.filter(needs).sort((a, b) => byName(a.displayName, b.displayName)),
    rows,
  };
}

/** A skill that came with a plugin, as the Skills page lists it. */
export interface PluginSkillRow {
  skill: PluginSkill;
  plugin: Plugin;
}

export interface SkillsModel {
  /** How many authored skills each segment holds, before the search. */
  counts: Record<Segment, number>;
  /** The segment's authored skills that match the search, by name. */
  rows: AuthoredSkill[];
  /**
   * Skills that came with the segment's plugins acting here and match the
   * search, by name. A person's plugin not on here brings nothing here.
   */
  fromPlugins: PluginSkillRow[];
}

export function buildSkillsModel(
  skills: readonly AuthoredSkill[],
  plugins: readonly Plugin[],
  opts: { segment: Segment; query: string },
): SkillsModel {
  const terms = searchTerms(opts.query);
  const counts: Record<Segment, number> = { workspace: 0, personal: 0 };
  for (const s of skills) counts[skillSegment(s)] += 1;

  const rows = skills
    .filter((s) => skillSegment(s) === opts.segment)
    .filter((s) => matches(`${s.name} ${s.description ?? ""}`, terms))
    .sort((a, b) => byName(a.name, b.name));
  const fromPlugins = plugins
    .filter((p) => pluginSegment(p) === opts.segment && p.granted)
    .flatMap((plugin) => plugin.skills.map((skill) => ({ skill, plugin })))
    .filter(({ skill, plugin }) =>
      matches(`${skill.name} ${skill.description ?? ""} ${plugin.displayName}`, terms),
    )
    .sort((a, b) => byName(a.skill.name, b.skill.name));
  return { counts, rows, fromPlugins };
}
