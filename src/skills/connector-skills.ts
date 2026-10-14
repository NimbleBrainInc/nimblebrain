/**
 * Server-skill adapter (SEP-2640 `io.modelcontextprotocol/skills`).
 *
 * Synthesizes Layer 3 `Skill` objects from the `skills/list` entries of an MCP
 * server that declares the Skills extension (`skills-extension.ts`). A server
 * that does not declare it publishes no skills; its `skill://` resources are
 * ordinary resources (ADR-0011).
 *
 * Why this exists:
 *
 *   An MCP server publishes its agent guidance as skills — markdown playbooks
 *   (Agent-Skills frontmatter + body) teaching the agent how to chain tools,
 *   recover from errors, etc. The runtime discovers them from the server's own
 *   listing and never guesses a URI from the source name, which differs from
 *   the skill's path on every connector named by a reverse-DNS slug. Discovery
 *   runs for every MCP source in the workspace, not only an entered app, so a
 *   workspace-level chat that can call a server's tools also gets the guidance
 *   for using them.
 *
 *   Each entry becomes a synthetic `Skill` built from the listing alone: the
 *   entry's frontmatter carries the name, description, and loading
 *   configuration. The body is not read until the skill is needed — the
 *   extension forbids fetching a skill's files ahead of need — so the `Skill`
 *   carries a `loadBody` the composer resolves through `hydrateSkill`. The
 *   synthesized skill flows through `partitionSkillsByRole`: a `dynamic` skill
 *   routes to the `selectLayer3Skills` capability channel, tool-affined to the
 *   server's tools it declares, or to `<serverName>__*` when it declares none
 *   (`connectorToolAffinity`), and loads when a matching tool is in the active
 *   toolset; an `always` skill routes to the always-on context
 *   channel (composed every turn, the same path filesystem `always` skills use).
 *
 *   Loading config is READ from the skill's frontmatter, not invented: a server
 *   declares `metadata.nimblebrain.loading-strategy` (and an optional
 *   `priority`, `triggers`, and `tool-affinity`) exactly as a filesystem skill does, and the host
 *   honors it — identical frontmatter must not behave differently by origin. A
 *   skill that declares nothing defaults to `dynamic`.
 *
 *   The `appContext`-driven `<app-guide>` injection is separate — it has
 *   different semantics (per-app focus, trust-score gating, reference-resource
 *   hint) than role-based skill composition.
 */

import matter from "gray-matter";

import { log } from "../observability/log.ts";
import { toolNameMatchesPattern } from "../tools/tool-pattern.ts";
import { resolveLoadingMechanism, type SkillLoadingMechanism } from "./loading.ts";
import type { SkillEntry } from "./skills-extension.ts";
import type { Skill, SkillBodyLoad, SkillLoadingStrategy, SkillScope } from "./types.ts";

/** Scope tag used on synthesized server skills. */
export const PUBLISHED_SKILL_SCOPE: SkillScope = "provided";

/**
 * Default priority for a synthesized server skill that declares none. Mid-range —
 * below `always` skills that workspace authors set explicitly, above default
 * catch-alls. A server may override it via `metadata.nimblebrain.priority`.
 */
const CONNECTOR_SKILL_PRIORITY = 60;

/** Loading strategy a synthesized server skill falls back to when it declares none. */
const DEFAULT_CONNECTOR_LOADING_STRATEGY: SkillLoadingStrategy = "dynamic";

/**
 * Prefix on a connector skill's manifest name. The manifest name is the skill's
 * de-duplication identity, so it namespaces the connector's own skill name —
 * two connectors both publishing `usage` have to stay distinct. On-disk skill
 * names match `SKILL_NAME_PATTERN` (lowercase alphanumerics and hyphens, no
 * colons), so a name carrying this prefix can only have been built here.
 */
const CONNECTOR_SKILL_NAME_PREFIX = "connector:";

/** Manifest name (identity) for a skill published by `connector`. */
export function connectorSkillManifestName(connector: string, skillName: string): string {
  return `${CONNECTOR_SKILL_NAME_PREFIX}${connector}:${skillName}`;
}

/**
 * Split a manifest name back into the connector that published the skill and
 * the skill's own name, or `null` for a name this module didn't build.
 *
 * Format and parse live together so a display surface reads provenance from the
 * identity the runtime assigned, rather than re-deriving it from the skill's
 * `skill://…/SKILL.md` id (whose last segment is the literal `SKILL`) or from
 * its `<connector>__*` tool glob.
 */
export function parseConnectorSkillName(
  manifestName: string,
): { connector: string; name: string } | null {
  if (!manifestName.startsWith(CONNECTOR_SKILL_NAME_PREFIX)) return null;
  const rest = manifestName.slice(CONNECTOR_SKILL_NAME_PREFIX.length);
  const sep = rest.indexOf(":");
  // Both halves must be non-empty for the split to name anything.
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { connector: rest.slice(0, sep), name: rest.slice(sep + 1) };
}

/**
 * A skill discovered on an MCP server, from its `skills/list` entry. It
 * carries no body: the body is fetched when the skill is needed.
 */
export interface DiscoveredSkill {
  /** The skill's `SKILL.md` URI. */
  uri: string;
  /** Frontmatter `name`, qualified by skill path when it collides on one server. */
  name: string;
  /** Frontmatter `description`. */
  description: string;
  /**
   * Declared `metadata.nimblebrain.loading-strategy`, when the server set one.
   * `undefined` means the skill opted out — synthesis defaults it to `dynamic`.
   */
  loadingStrategy?: SkillLoadingStrategy;
  /** Declared `metadata.nimblebrain.priority`, when the server set one. */
  priority?: number;
  /**
   * Declared `metadata.nimblebrain.triggers` — explicit phrases the per-request
   * `SkillMatcher` fires on. Absent when the server declared none.
   */
  triggers?: string[];
  /**
   * Declared `metadata.nimblebrain.tool-affinity` — bare tool names or globs
   * within the publishing server. Absent when the server declared none.
   */
  toolAffinity?: string[];
  /** The listing entry: what a fetched body is verified against. */
  entry: SkillEntry;
}

/** A discovered skill built from a validated `skills/list` entry. */
export function discoveredSkillFromEntry(entry: SkillEntry): DiscoveredSkill {
  return {
    uri: entry.uri,
    name: entry.frontmatter.name,
    description: entry.frontmatter.description,
    ...readDeclaredLoading(entry.frontmatter),
    entry,
  };
}

/**
 * Give every skill in one server's set a distinct `name`.
 *
 * A name is a label, not an identity: two skills at different paths on one
 * server may share a final segment (`acme/billing/refunds`,
 * `acme/support/refunds`). The manifest name built from it is the runtime's
 * de-duplication key, so a shared name would silently drop one. Each skill in
 * a colliding group is named by its full skill path instead; a name no other
 * skill shares is left alone.
 */
export function disambiguateSkillNames(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  return skills.map((skill) =>
    (counts.get(skill.name) ?? 0) > 1 ? { ...skill, name: skillPath(skill.uri) } : skill,
  );
}

/** The skill path of a `<scheme>://<skill-path>/SKILL.md` URI: `skill://acme/billing/refunds/SKILL.md` → `acme/billing/refunds`. */
function skillPath(uri: string): string {
  return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/SKILL\.md$/, "");
}

/**
 * Bind a connector skill's tool-affinity to the server it belongs to.
 *
 * A connector skill is authored without knowing the name its server is
 * installed under, so it declares affinity as bare tool names or globs of its
 * own tools (`draft_email`, `draft_*`), and the runtime prefixes each with
 * `<serverName>__`. The prefix is also the containment: matching is anchored
 * (`toolNameMatchesPattern`), so a prefixed pattern reaches only this server's
 * tools — a declared `*` means every tool of this server, and no declared value
 * can name another connector's tools or a personal (`my_`) one. Blank entries
 * are dropped.
 *
 * With nothing declared, the skill is bound to the whole server (`<serverName>__*`).
 */
export function connectorToolAffinity(
  serverName: string,
  declared: readonly string[] | undefined,
): string[] {
  const patterns = (declared ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `${serverName}__${p}`);
  return patterns.length > 0 ? [...new Set(patterns)] : [`${serverName}__*`];
}

/**
 * The patterns of a bound tool-affinity that match none of `toolNames`.
 */
export function unmatchedToolAffinity(
  affinity: readonly string[],
  toolNames: readonly string[],
): string[] {
  return affinity.filter((p) => !toolNames.some((t) => toolNameMatchesPattern(t, p)));
}

/**
 * Warn for each connector skill whose bound tool-affinity has a pattern that
 * matches none of the tools its connector advertises. Such a pattern never
 * selects the skill, so a misspelled or renamed tool would otherwise leave the
 * guidance silently dark. A connector that advertises no tools says nothing
 * about the patterns (it is not connected yet), so it is not checked.
 */
export function reportUnmatchedToolAffinity(input: {
  wsId: string;
  serverName: string;
  skills: readonly { name: string; toolAffinity: readonly string[] }[];
  toolNames: readonly string[];
}): void {
  if (input.toolNames.length === 0) return;
  for (const skill of input.skills) {
    const unmatched = unmatchedToolAffinity(skill.toolAffinity, input.toolNames);
    if (unmatched.length === 0) continue;
    log.warn("[skill] connector skill declares a tool-affinity no tool of its connector matches", {
      event: "skills.tool_affinity.unmatched",
      workspace_id: input.wsId,
      server: input.serverName,
      skill: skill.name,
      patterns: unmatched,
    });
  }
}

/**
 * Read the declared loading configuration — strategy, priority, trigger
 * phrases, and tool-affinity — from a discovered skill's parsed frontmatter, using the SAME
 * `metadata.nimblebrain.*` fields the filesystem loader reads
 * (`mapFrontmatterToManifest`). Every field is READ, not invented, so identical
 * frontmatter means identical loading behavior whether the skill came off disk
 * or from an MCP server's `skills/list` entry.
 *
 * Lenient by design: a discovered skill is authored by an arbitrary MCP server,
 * so — unlike the strict on-disk loader — a non-conforming or absent block does
 * not reject the skill; it just leaves the fields `undefined` (synthesis then
 * applies the defaults). Only recognized values are returned: strategy must be
 * `always` or `dynamic`; priority must be a number in [0, 100]; triggers must be
 * an array, from which non-string and blank entries are dropped (a trigger that
 * is empty after trimming would substring-match every message). Tool-affinity
 * is read the same way and stays bare here; synthesis binds it to the server
 * ({@link connectorToolAffinity}).
 */
function readDeclaredLoading(data: Record<string, unknown>): {
  loadingStrategy?: SkillLoadingStrategy;
  priority?: number;
  triggers?: string[];
  toolAffinity?: string[];
} {
  const metadata = data.metadata;
  const nb =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).nimblebrain
      : undefined;
  if (!nb || typeof nb !== "object") return {};
  const block = nb as Record<string, unknown>;
  const strategy = block["loading-strategy"];
  const priority = block.priority;
  const triggers = nonBlankStrings(block.triggers);
  const toolAffinity = nonBlankStrings(block["tool-affinity"]);
  return {
    ...(strategy === "always" || strategy === "dynamic" ? { loadingStrategy: strategy } : {}),
    ...(typeof priority === "number" && priority >= 0 && priority <= 100 ? { priority } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(toolAffinity.length > 0 ? { toolAffinity } : {}),
  };
}

/** The non-blank strings of `value` when it is an array, else none. */
function nonBlankStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
}

/**
 * The final skill-path segment of a `skill://<skill-path>/SKILL.md` URI — the
 * directory name that, per SEP-2640, equals the skill's `name`. Used as the
 * `name` fallback when frontmatter omits it.
 * `skill://acme/billing/refunds/SKILL.md` → `refunds`;
 * `skill://git-workflow/SKILL.md` → `git-workflow`.
 */
function skillPathSegment(uri: string): string {
  const withoutEntry = uri.replace(/\/SKILL\.md$/, "");
  const segments = withoutEntry
    .replace(/^skill:\/\//, "")
    .split("/")
    .filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/**
 * Parse a `SKILL.md` resource into `{ name, description, body, loadingStrategy?,
 * priority?, triggers? }`. The format is the external Agent-Skills spec: YAML
 * frontmatter (`name`, `description`, and the optional `metadata.nimblebrain`
 * runtime block) + a markdown body. Frontmatter `name` wins; the URI's final
 * skill-path segment is the fallback (SEP-2640 requires them to match, but we
 * don't hard-fail on a server that omits the field). The declared
 * `loading-strategy` / `priority` / `triggers` (if any) are read from
 * `metadata.nimblebrain.*`. Malformed frontmatter degrades to the raw body with
 * no declared loading config.
 */
export function parseSkillMarkdown(
  uri: string,
  raw: string,
): { name: string; description: string; body: string } & ReturnType<typeof readDeclaredLoading> {
  const fallbackName = skillPathSegment(uri);
  try {
    const { data, content } = matter(raw);
    const name = typeof data.name === "string" && data.name ? data.name : fallbackName;
    const description = typeof data.description === "string" ? data.description : "";
    return { name, description, body: content, ...readDeclaredLoading(data) };
  } catch {
    // Malformed frontmatter — inject the whole document rather than lose it.
    return { name: fallbackName, description: "", body: raw };
  }
}

export interface ConnectorSkillInput {
  /** MCP server (source) name — matches the prefix used in surfaced tool names. */
  serverName: string;
  /** Skill `name` from the SKILL.md frontmatter (or the URI path segment). */
  skillName: string;
  /** Skill `description` from frontmatter (may be empty). */
  description: string;
  /**
   * Fetch the body when the skill is needed: frontmatter-stripped, truncated to
   * budget, verified, or the reason it cannot be. The synthesized `Skill`
   * carries it and an empty `body` until {@link hydrateSkill} resolves it.
   */
  loadBody?: () => Promise<SkillBodyLoad>;
  /** A body already in hand, for a skill that needs no fetch. */
  body?: string;
  /** The skill's `SKILL.md` URI. */
  uri: string;
  /**
   * Declared loading strategy from the skill's frontmatter. Defaults to
   * `dynamic` when the server declared none (backward-compatible with usage
   * skills that only ever wanted tool-affined loading).
   */
  loadingStrategy?: SkillLoadingStrategy;
  /** Declared priority from the skill's frontmatter. Defaults to {@link CONNECTOR_SKILL_PRIORITY}. */
  priority?: number;
  /**
   * Declared trigger phrases from the skill's frontmatter. Stamped onto the
   * manifest so the per-request `SkillMatcher` can fire the skill on an explicit
   * phrase — the deterministic (must-fire) channel, independent of whether the
   * publishing server's tools happen to be in the active toolset.
   */
  triggers?: string[];
  /**
   * Declared tool-affinity from the skill's frontmatter: bare tool names or
   * globs within this server, bound to it by {@link connectorToolAffinity}.
   */
  toolAffinity?: string[];
}

/**
 * Synthesize a `Skill` from a server-published skill, honoring the strategy the
 * skill DECLARES:
 *  - `dynamic` (the default when none is declared): tool-affined to the tools
 *    it declares, prefixed `<serverName>__` ({@link connectorToolAffinity}), or
 *    to `<serverName>__*` when it declares none. It loads via
 *    `selectLayer3Skills` when a matching tool is in the active toolset, and is
 *    delivered mid-turn when a matching tool is promoted or called.
 *  - `always`: composed into the always-on context channel every turn (routed
 *    there by `partitionSkillsByRole`). `toolAffinity` is still stamped but
 *    unused on this path — the context channel is unconditional.
 *
 * Declared `triggers` are stamped verbatim. They are orthogonal to the strategy:
 * a `dynamic` skill with triggers is reachable BOTH by tool-affinity and by an
 * explicit phrase, and the phrase fires even when the server's tools are proxied
 * out of the active set. `always` skills are never matched (the matcher filters
 * to `dynamic`), so triggers on one are inert by construction — it already loads
 * every turn.
 *
 * Pure function — no I/O, no caching. The caller (runtime) handles discovery,
 * fetch, parse, and cache. Keeping the synthesis pure means it's trivial to
 * unit-test the manifest shape without spinning up a registry.
 *
 * Observability contract: when a `dynamic` skill is selected by
 * `selectLayer3Skills`, `buildSkillsLoadedPayload` emits it on the
 * `skills.loaded` event with `id = <uri>`, `scope = "provided"`,
 * `loadedBy = "tool_affinity"` — byte-identical in payload structure to any
 * filesystem-sourced Layer 3 skill with the same scope / strategy, plus
 * `name` / `connector` split out of the manifest name so a reader gets the
 * skill's own name and who published it.
 */
export function synthesizeConnectorSkill(input: ConnectorSkillInput): Skill {
  const { serverName, skillName, description, uri, loadingStrategy, priority, triggers } = input;
  const toolAffinity = connectorToolAffinity(serverName, input.toolAffinity);
  return {
    manifest: {
      name: connectorSkillManifestName(serverName, skillName),
      description: description || `Workflow guidance from the ${serverName} server`,
      priority: priority ?? CONNECTOR_SKILL_PRIORITY,
      scope: PUBLISHED_SKILL_SCOPE,
      loadingStrategy: loadingStrategy ?? DEFAULT_CONNECTOR_LOADING_STRATEGY,
      toolAffinity,
      ...(triggers?.length ? { triggers } : {}),
      status: "active",
    },
    body: input.body ?? "",
    sourcePath: uri,
    ...(input.loadBody ? { loadBody: input.loadBody } : {}),
  };
}

/**
 * Resolve a skill's body if it is fetched on demand, or `null` when the fetch
 * fails. The result carries no `loadBody`, so it can be composed as is. Call
 * this only where the body is about to reach the model.
 */
export async function hydrateSkill(skill: Skill): Promise<Skill | null> {
  if (!skill.loadBody) return skill;
  const loaded = await skill.loadBody();
  if (!loaded.ok) return null;
  const { loadBody: _loaded, ...rest } = skill;
  return { ...rest, body: loaded.body };
}

/**
 * One skill a connected server publishes, as the runtime loads it. Backs
 * `manage_connectors list_bound_skills`, so a workspace admin can audit what a
 * server puts into the model's context without the body being fetched.
 */
export interface PublishedSkillInfo {
  /** The publishing server (the install's tool-namespace prefix). */
  server: string;
  /** The skill's own name on that server. */
  name: string;
  description: string;
  /** The skill's `SKILL.md` URI on the server. */
  uri: string;
  loadingStrategy: SkillLoadingStrategy;
  priority: number;
  /** The tool patterns the skill is bound to, under the server's namespace. */
  toolAffinity: string[];
  triggers?: string[];
  /** How the skill reaches the model ({@link resolveLoadingMechanism}). */
  mechanism: SkillLoadingMechanism;
}

/**
 * Project a synthesized server skill to its {@link PublishedSkillInfo}, or
 * `null` for a skill this module did not synthesize.
 */
export function publishedSkillInfo(skill: Skill): PublishedSkillInfo | null {
  const id = parseConnectorSkillName(skill.manifest.name);
  if (!id) return null;
  const { manifest } = skill;
  return {
    server: id.connector,
    name: id.name,
    description: manifest.description,
    uri: skill.sourcePath,
    loadingStrategy: manifest.loadingStrategy,
    priority: manifest.priority,
    toolAffinity: manifest.toolAffinity ?? [],
    ...(manifest.triggers?.length ? { triggers: manifest.triggers } : {}),
    mechanism: resolveLoadingMechanism(manifest),
  };
}
