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
 *   resources and wraps each body in a synthetic `Skill` with
 *   `loadingStrategy: "dynamic"` and `toolAffinity: ["<serverName>__*"]`. The
 *   skill then flows through the standard `selectLayer3Skills` path: if any
 *   `<serverName>__*` tool is in the active toolset, the skill loads.
 *
 *   This is strictly additive. The `appContext`-driven `<app-guide>` injection
 *   remains untouched — it has different semantics (per-app focus, trust-score
 *   gating, reference-resource hint) than Layer 3 selection.
 *
 * NOTE: the exported names keep the `bundle`/`Bundle` prefix to bound the diff,
 * but a skill is a property of the MCP *server*, independent of the mpak
 * "bundle" packaging (which is being phased out).
 */

import matter from "gray-matter";

import type { Skill, SkillScope } from "./types.ts";

/** Scope tag used on synthesized server skills. */
export const BUNDLE_SKILL_SCOPE: SkillScope = "bundle";

/** Priority for synthesized server skills. Mid-range — below `always` skills
 * that workspace authors set explicitly, above default catch-alls. */
const BUNDLE_SKILL_PRIORITY = 60;

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
 * Parse a `SKILL.md` resource into `{ name, description, body }`. The format is
 * the external Agent-Skills spec: YAML frontmatter (`name`, `description`) + a
 * markdown body. Frontmatter `name` wins; the URI's final skill-path segment is
 * the fallback (SEP-2640 requires them to match, but we don't hard-fail on a
 * server that omits the field). Malformed frontmatter degrades to the raw body.
 */
export function parseSkillMarkdown(
  uri: string,
  raw: string,
): { name: string; description: string; body: string } {
  const fallbackName = skillPathSegment(uri);
  try {
    const { data, content } = matter(raw);
    const name = typeof data.name === "string" && data.name ? data.name : fallbackName;
    const description = typeof data.description === "string" ? data.description : "";
    return { name, description, body: content };
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
}

/**
 * Synthesize a Layer 3 `Skill` from a server-exposed `skill://<name>/SKILL.md`
 * resource. The skill is `dynamic` with tool-affinity `<serverName>__*`, so it
 * loads whenever the server's tools are in the active toolset.
 *
 * Pure function — no I/O, no caching. The caller (runtime) handles discovery,
 * fetch, parse, and cache. Keeping the synthesis pure means it's trivial to
 * unit-test the manifest shape without spinning up a registry.
 *
 * Observability contract: when this skill is selected by `selectLayer3Skills`,
 * `buildSkillsLoadedPayload` emits it on the `skills.loaded` event with
 * `id = <uri>`, `scope = "bundle"`, `loadedBy = "tool_affinity"` — byte-identical
 * in payload structure to any filesystem-sourced Layer 3 skill with the same
 * scope / strategy.
 */
export function synthesizeBundleSkill(input: BundleSkillInput): Skill {
  const { serverName, skillName, description, body, uri } = input;
  return {
    manifest: {
      name: `bundle:${serverName}:${skillName}`,
      description: description || `Workflow guidance from the ${serverName} server`,
      priority: BUNDLE_SKILL_PRIORITY,
      scope: BUNDLE_SKILL_SCOPE,
      loadingStrategy: "dynamic",
      toolAffinity: [`${serverName}__*`],
      status: "active",
    },
    body,
    sourcePath: uri,
  };
}
