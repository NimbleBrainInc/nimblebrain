/**
 * Server-skill adapter (SEP-2640 `io.modelcontextprotocol/skills`).
 *
 * Synthesizes Layer 3 `Skill` objects from the `skill://<name>/SKILL.md`
 * resources an MCP server exposes, discovered via `resources/list`. This makes a
 * server-side workflow guide discoverable through the same tool-affined loading
 * machinery that picks up filesystem skills — no need for the chat to be scoped
 * to a specific app via `appContext`.
 *
 * Why this exists:
 *
 *   An MCP server can publish its agent guidance as skill resources — markdown
 *   playbooks (Agent-Skills frontmatter + body) teaching the agent how to chain
 *   tools, recover from errors, etc. Per SEP-2640 the entrypoint is always
 *   `skill://<skill-path>/SKILL.md`, whose final path segment is the skill's
 *   frontmatter `name`. The runtime DISCOVERS these by listing the server's
 *   resources — it never guesses the URI from the source name. That guess
 *   (`skill://<serverName>/usage`) silently missed every fleet connector, whose
 *   `source.name` is the reverse-DNS slug (`ai-nimblebrain-<x>-mcp`) rather than
 *   the skill's short name. The earlier path also only fired when the request
 *   had `appContext` pinning the conversation to that server; in a
 *   workspace-level chat where the server's tools are visible but no app is
 *   "entered," the skill went unread — including the directive that tells the
 *   model which tool to use. Production case: a cobranding turn looped on
 *   `list_documents` until the supervisor halted because the model never read
 *   the rules.
 *
 *   This adapter closes both gaps. At chat-build time, for each MCP source in
 *   the active workspace registry, the runtime discovers its `skill://…/SKILL.md`
 *   resources and wraps each body in a synthetic `Skill`. The synthesized skill
 *   then flows through `partitionSkillsByRole`: a `dynamic` skill routes to the
 *   `selectLayer3Skills` capability channel with `toolAffinity: ["<serverName>__*"]`
 *   (loads when the server's tools are in the active toolset); an `always` skill
 *   routes to the always-on context channel (composed every turn, the same
 *   reliable path filesystem `always` skills use).
 *
 *   Loading strategy is READ from the discovered skill's frontmatter, not
 *   invented: a server declares `metadata.nimblebrain.loading-strategy` (and an
 *   optional `priority`) exactly as a filesystem skill does, and the host honors
 *   it. A skill that declares nothing defaults to `dynamic` — backward-compatible
 *   with servers that publish tool-affined usage guidance and never opt in. This
 *   lets a server route an always-present workflow guide to the reliable context
 *   channel, rather than the capability channel that only selects once at
 *   turn-start (so a workflow skill could silently never load once its tools were
 *   promoted after selection).
 *
 *   This is strictly additive. The `appContext`-driven `<app-guide>` injection
 *   remains untouched — it has different semantics (per-app focus, trust-score
 *   gating, reference-resource hint) than role-based skill composition.
 *
 * NOTE: the exported names keep the `bundle`/`Bundle` prefix to bound the diff,
 * but a skill is a property of the MCP *server*, independent of the mpak
 * "bundle" packaging (which is being phased out).
 */

import matter from "gray-matter";

import type { Skill, SkillLoadingStrategy, SkillScope } from "./types.ts";

/** Scope tag used on synthesized server skills. */
export const BUNDLE_SKILL_SCOPE: SkillScope = "bundle";

/**
 * Default priority for a synthesized server skill that declares none. Mid-range —
 * below `always` skills that workspace authors set explicitly, above default
 * catch-alls. A server may override it via `metadata.nimblebrain.priority`.
 */
const BUNDLE_SKILL_PRIORITY = 60;

/** Loading strategy a synthesized server skill falls back to when it declares none. */
const DEFAULT_BUNDLE_LOADING_STRATEGY: SkillLoadingStrategy = "dynamic";

/**
 * SEP-2640 skill entrypoint: `skill://<skill-path>/SKILL.md`. A skill is a
 * `skill://` resource whose URI ends in `/SKILL.md`; supporting files
 * (`skill://…/scripts/x.py`) share the prefix but are not entrypoints.
 */
export const SKILL_ENTRYPOINT_RE = /^skill:\/\/.+\/SKILL\.md$/;

/** True iff `uri` is a SEP-2640 skill entrypoint (`skill://…/SKILL.md`). */
export function isSkillEntrypointUri(uri: string): boolean {
  return SKILL_ENTRYPOINT_RE.test(uri);
}

/** A skill discovered on an MCP server: its entrypoint URI + parsed content. */
export interface DiscoveredSkill {
  /** The `skill://…/SKILL.md` entrypoint URI. */
  uri: string;
  /** Frontmatter `name` (falls back to the final skill-path segment). */
  name: string;
  /** Frontmatter `description` (empty string when absent). */
  description: string;
  /** SKILL.md body, frontmatter stripped and truncated to budget. */
  body: string;
  /**
   * Declared `metadata.nimblebrain.loading-strategy`, when the server set one.
   * `undefined` means the skill opted out — synthesis defaults it to `dynamic`.
   */
  loadingStrategy?: SkillLoadingStrategy;
  /** Declared `metadata.nimblebrain.priority`, when the server set one. */
  priority?: number;
}

/**
 * Read the declared loading strategy + priority from a discovered skill's parsed
 * frontmatter, using the SAME `metadata.nimblebrain.*` fields the filesystem
 * loader reads (`mapFrontmatterToManifest`) — the strategy is READ, not invented.
 *
 * Lenient by design: a discovered skill is authored by an arbitrary MCP server,
 * so — unlike the strict on-disk loader — a non-conforming or absent block does
 * not reject the skill; it just leaves the fields `undefined` (synthesis then
 * applies the defaults). Only recognized values are returned: strategy must be
 * `always` or `dynamic`; priority must be a number in [0, 100].
 */
function readDeclaredLoading(data: Record<string, unknown>): {
  loadingStrategy?: SkillLoadingStrategy;
  priority?: number;
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
  return {
    ...(strategy === "always" || strategy === "dynamic" ? { loadingStrategy: strategy } : {}),
    ...(typeof priority === "number" && priority >= 0 && priority <= 100 ? { priority } : {}),
  };
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
 * priority? }`. The format is the external Agent-Skills spec: YAML frontmatter
 * (`name`, `description`, and the optional `metadata.nimblebrain` runtime block)
 * + a markdown body. Frontmatter `name` wins; the URI's final skill-path segment
 * is the fallback (SEP-2640 requires them to match, but we don't hard-fail on a
 * server that omits the field). The declared `loading-strategy` / `priority` (if
 * any) are read from `metadata.nimblebrain.*`. Malformed frontmatter degrades to
 * the raw body with no declared strategy.
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

export interface BundleSkillInput {
  /** MCP server (source) name — matches the prefix used in surfaced tool names. */
  serverName: string;
  /** Skill `name` from the SKILL.md frontmatter (or the URI path segment). */
  skillName: string;
  /** Skill `description` from frontmatter (may be empty). */
  description: string;
  /** SKILL.md body, already frontmatter-stripped and truncated to budget. */
  body: string;
  /** The `skill://…/SKILL.md` entrypoint URI the body was read from. */
  uri: string;
  /**
   * Declared loading strategy from the skill's frontmatter. Defaults to
   * `dynamic` when the server declared none (backward-compatible with usage
   * skills that only ever wanted tool-affined loading).
   */
  loadingStrategy?: SkillLoadingStrategy;
  /** Declared priority from the skill's frontmatter. Defaults to {@link BUNDLE_SKILL_PRIORITY}. */
  priority?: number;
}

/**
 * Synthesize a `Skill` from a server-exposed `skill://<name>/SKILL.md` resource,
 * honoring the strategy the skill DECLARES:
 *  - `dynamic` (the default when none is declared): tool-affined to
 *    `<serverName>__*`, so it loads via `selectLayer3Skills` whenever the
 *    server's tools are in the active toolset.
 *  - `always`: composed into the always-on context channel every turn (routed
 *    there by `partitionSkillsByRole`). `toolAffinity` is still stamped but
 *    unused on this path — the context channel is unconditional.
 *
 * Pure function — no I/O, no caching. The caller (runtime) handles discovery,
 * fetch, parse, and cache. Keeping the synthesis pure means it's trivial to
 * unit-test the manifest shape without spinning up a registry.
 *
 * Observability contract: when a `dynamic` skill is selected by
 * `selectLayer3Skills`, `buildSkillsLoadedPayload` emits it on the
 * `skills.loaded` event with `id = <uri>`, `scope = "bundle"`,
 * `loadedBy = "tool_affinity"` — byte-identical in payload structure to any
 * filesystem-sourced Layer 3 skill with the same scope / strategy.
 */
export function synthesizeBundleSkill(input: BundleSkillInput): Skill {
  const { serverName, skillName, description, body, uri, loadingStrategy, priority } = input;
  return {
    manifest: {
      name: `bundle:${serverName}:${skillName}`,
      description: description || `Workflow guidance from the ${serverName} server`,
      priority: priority ?? BUNDLE_SKILL_PRIORITY,
      scope: BUNDLE_SKILL_SCOPE,
      loadingStrategy: loadingStrategy ?? DEFAULT_BUNDLE_LOADING_STRATEGY,
      toolAffinity: [`${serverName}__*`],
      status: "active",
    },
    body,
    sourcePath: uri,
  };
}
