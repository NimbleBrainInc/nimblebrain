/**
 * Resolve a connector's curated skills from a pinned plugin catalog (ADR-0068).
 *
 * The curated guidance for a connector NimbleBrain does not author ships as a
 * skill in that connector's plugin. The catalog publishes:
 *
 *     <catalog>/nimblebrain/marketplace/<pin>.json   the NimbleBrain index, kept for good
 *     <archive url from the index>                   each plugin's zip, with its sha256
 *
 * A plugin names its servers in `plugin.json` under
 * `extensions["ai.nimblebrain"].servers` (key → registry name), and a skill binds
 * to one of them by naming its key under `metadata.nimblebrain.server`. A skill
 * that names no server is not a connector's guidance and is not returned here.
 * Nothing derives a binding from a connector's name.
 *
 * The index and archives are read through `src/plugins/pinned-catalog.ts`:
 * pinned by sha256, bounded, cached by content, and fail-closed, so a missing
 * index, any non-2xx, a network error, an unreadable archive, or a digest
 * mismatch throws and nothing partial is returned.
 *
 * A server no plugin names, or whose plugin carries no skill bound to it, has
 * no curated skill: the answer is `[]`, read from verified bytes, so it is a
 * definite answer rather than a guess from a 404.
 *
 * The same verified plugins carry their conversation starters: what a host
 * offers a person who has the plugin and does not know what to ask, under
 * `extensions["ai.nimblebrain"].conversationStarters` in `plugin.json` as
 * `{title, text}`. `resolveServerConversationStarters` returns them for the
 * servers a workspace has.
 */

import type { ConversationStarter } from "../plugins/extension.ts";
import { nimblebrainExtension } from "../plugins/manifest.ts";
import {
  type IndexEntry,
  loadArchive,
  loadIndex,
  mapArchives,
  openArchive,
  type PinnedCatalogOptions,
} from "../plugins/pinned-catalog.ts";
import { sha256Hex } from "../util/pinned-fetch.ts";
import { parseFrontmatter } from "./frontmatter.ts";

export { MAX_FETCH_BYTES, pinnedIndexUrl } from "../plugins/pinned-catalog.ts";

/** One curated skill bound to a server, as read from its plugin. */
export interface PluginSkill {
  /** Plugin name in its catalog (`gmail`). */
  plugin: string;
  /** The catalog's name from its index (`nimblebrain`). */
  catalog: string;
  /** sha256 of the plugin's archive. */
  digest: string;
  /** Skill name (its folder in the plugin). */
  skill: string;
  /** The SKILL.md, verbatim. */
  body: string;
  /** sha256 of the SKILL.md. */
  sha: string;
}

export type ResolveServerSkillsOptions = PinnedCatalogOptions;

/** One conversation starter from a plugin: the action a person reads, and the text sent. */
export type PluginConversationStarter = ConversationStarter;

/** The conversation starters of the plugin that names one server. */
export interface ServerConversationStarters {
  /** The server's registry name (`com.google/gmail`). */
  server: string;
  /** Plugin name in its catalog (`gmail`). */
  plugin: string;
  conversationStarters: PluginConversationStarter[];
}

/** What the runtime keeps of one plugin: its servers, server-bound skills, and starters. */
interface PluginRecord {
  servers: Record<string, string>;
  skills: Array<{ name: string; server: string; body: string }>;
  conversationStarters: PluginConversationStarter[];
}

/**
 * Every curated skill in the pinned catalog bound to the server with registry
 * name `server` (`com.google/gmail`), in index order. `[]` when no plugin binds
 * a skill to it. Throws on any fetch or integrity failure.
 */
export async function resolveServerSkills(
  server: string,
  opts: ResolveServerSkillsOptions,
): Promise<PluginSkill[]> {
  const index = await loadIndex(opts);
  const records = await mapArchives(index.plugins, (entry) => loadPlugin(entry, opts));
  const out: PluginSkill[] = [];
  index.plugins.forEach((entry, i) => {
    const record = records[i]!;
    const keys = new Set(
      Object.entries(record.servers)
        .filter(([, name]) => name === server)
        .map(([key]) => key),
    );
    for (const skill of record.skills) {
      if (!keys.has(skill.server)) continue;
      out.push({
        plugin: entry.name,
        catalog: index.name,
        digest: entry.sha256,
        skill: skill.name,
        body: skill.body,
        sha: sha256Hex(Buffer.from(skill.body, "utf8")),
      });
    }
  });
  return out;
}

/**
 * The conversation starters of each plugin that names one of `servers`
 * (registry names), in index order. A server no plugin names, or whose plugin
 * has none, is left out. Throws on any fetch or integrity failure, as skills do.
 */
export async function resolveServerConversationStarters(
  servers: readonly string[],
  opts: ResolveServerSkillsOptions,
): Promise<ServerConversationStarters[]> {
  const wanted = new Set(servers);
  if (wanted.size === 0) return [];
  const index = await loadIndex(opts);
  const records = await mapArchives(index.plugins, (entry) => loadPlugin(entry, opts));
  const out: ServerConversationStarters[] = [];
  index.plugins.forEach((entry, i) => {
    const record = records[i]!;
    if (record.conversationStarters.length === 0) return;
    for (const server of new Set(Object.values(record.servers))) {
      if (wanted.has(server)) {
        out.push({ server, plugin: entry.name, conversationStarters: record.conversationStarters });
      }
    }
  });
  return out;
}

async function loadPlugin(
  entry: IndexEntry,
  opts: ResolveServerSkillsOptions,
): Promise<PluginRecord> {
  return readPlugin(entry.name, await loadArchive(entry, opts));
}

/**
 * Read a verified plugin archive: its servers, its starters, and each skill
 * that names one of its servers. The manifest and its `ai.nimblebrain`
 * extension are read by the plugin reader (`src/plugins/manifest.ts`), the
 * one place that knows those fields. A catalog vouches for the archive, so
 * the extension is read leniently: a malformed field is dropped, a missing
 * extension reads as none. Claude Code's `.claude-plugin/plugin.json` is read
 * when the archive has no root manifest.
 */
function readPlugin(name: string, archive: Uint8Array): PluginRecord {
  const { files, manifest } = openArchive(name, archive);
  const { servers, conversationStarters } = nimblebrainExtension(manifest);

  const skills: PluginRecord["skills"] = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!match) continue;
    const body = new TextDecoder().decode(bytes);
    const bound = field(field(field(frontmatter(body), "metadata"), "nimblebrain"), "server");
    if (typeof bound === "string" && bound in servers) {
      skills.push({ name: match[1]!, server: bound, body });
    }
  }
  return { servers, skills, conversationStarters };
}

/** A skill's frontmatter, or nothing when it does not parse (the skill is then unbound). */
function frontmatter(body: string): unknown {
  try {
    return parseFrontmatter(body).data;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
