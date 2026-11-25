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
 * ADR-0013's mechanics hold:
 *   - Pinned: the index is read at the sha256 the runtime is pinned to, and every
 *     archive at the sha256 that index lists. No tag, branch or bare URL.
 *   - Fail-closed: a missing index, any non-2xx, a network error, an unreadable
 *     archive, or a digest mismatch throws. Nothing partial is returned.
 *   - Content-addressed cache: the index and each plugin archive are cached as
 *     the bytes fetched, under their sha256, and verified again on every read,
 *     so one catalog read serves every workspace and a pin bump refetches only
 *     the plugins whose bytes changed.
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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationStarter } from "../plugins/extension.ts";
import { nimblebrainExtension, PLUGIN_MANIFEST_FILE, readPluginJson } from "../plugins/manifest.ts";
import { readZip } from "../util/zip.ts";
import { parseFrontmatter } from "./frontmatter.ts";

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

export interface ResolveServerSkillsOptions {
  /** Content-addressed cache directory (`{workDir}/cache/plugin-catalog`). */
  cacheDir: string;
  /** Catalog base URL, no trailing slash. */
  catalogUrl: string;
  /** sha256 of the catalog's NimbleBrain index. */
  pin: string;
  /** Injectable fetch; tests pass a fixture. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 15000. */
  timeoutMs?: number;
}

/** Where the catalog keeps the NimbleBrain index with this sha256. */
export function pinnedIndexUrl(catalogUrl: string, pin: string): string {
  return `${catalogUrl}/nimblebrain/marketplace/${pin}.json`;
}

/** Claude Code's manifest, read when an archive has no Agent Plugins root manifest. */
const CLAUDE_PLUGIN_MANIFEST_FILE = ".claude-plugin/plugin.json";

interface IndexEntry {
  name: string;
  url: string;
  sha256: string;
}

interface CatalogIndex {
  name: string;
  plugins: IndexEntry[];
}

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
  const records = await Promise.all(index.plugins.map((entry) => loadPlugin(entry, opts)));
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
  const records = await Promise.all(index.plugins.map((entry) => loadPlugin(entry, opts)));
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

async function loadIndex(opts: ResolveServerSkillsOptions): Promise<CatalogIndex> {
  const path = join(opts.cacheDir, "index", `${opts.pin}.json`);
  let bytes: Uint8Array;
  if (existsSync(path)) {
    bytes = readFileSync(path);
    assertDigest("catalog index", bytes, opts.pin);
  } else {
    bytes = await fetchBytes(pinnedIndexUrl(opts.catalogUrl, opts.pin), opts);
    assertDigest("catalog index", bytes, opts.pin);
    writeCache(path, bytes);
  }
  return parseIndex(JSON.parse(new TextDecoder().decode(bytes)));
}

async function loadPlugin(
  entry: IndexEntry,
  opts: ResolveServerSkillsOptions,
): Promise<PluginRecord> {
  const path = join(opts.cacheDir, "plugins", `${entry.sha256}.zip`);
  let bytes: Uint8Array;
  if (existsSync(path)) {
    bytes = readFileSync(path);
    assertDigest(`plugin ${entry.name}`, bytes, entry.sha256);
  } else {
    bytes = await fetchBytes(entry.url, opts);
    assertDigest(`plugin ${entry.name}`, bytes, entry.sha256);
    writeCache(path, bytes);
  }
  return readPlugin(entry.name, bytes);
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
  const files = readZip(archive);
  const manifestPath = files.has(PLUGIN_MANIFEST_FILE)
    ? PLUGIN_MANIFEST_FILE
    : CLAUDE_PLUGIN_MANIFEST_FILE;
  const manifestBytes = files.get(manifestPath);
  if (!manifestBytes) throw new Error(`plugin ${name}: archive has no plugin.json`);
  const { servers, conversationStarters } = nimblebrainExtension(
    readPluginJson(name, manifestPath, manifestBytes),
  );

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

function parseIndex(raw: unknown): CatalogIndex {
  const name = field(raw, "name");
  const plugins = field(raw, "plugins");
  if (typeof name !== "string" || !Array.isArray(plugins)) {
    throw new Error("catalog index has no name or plugins");
  }
  const entries: IndexEntry[] = [];
  for (const plugin of plugins) {
    const source = field(plugin, "source");
    const pluginName = field(plugin, "name");
    const url = field(source, "url");
    const sha256 = field(source, "sha256");
    // Only an archive pinned by its digest can be verified; a git source is not
    // read here.
    if (field(source, "source") !== "archive") continue;
    if (
      typeof pluginName !== "string" ||
      typeof url !== "string" ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      throw new Error(`catalog index lists a malformed plugin: ${JSON.stringify(plugin)}`);
    }
    entries.push({ name: pluginName, url, sha256 });
  }
  return { name, plugins: entries };
}

async function fetchBytes(url: string, opts: ResolveServerSkillsOptions): Promise<Uint8Array> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  if (!res.ok) throw new Error(`plugin catalog fetch failed: HTTP ${res.status} (${url})`);
  return new Uint8Array(await res.arrayBuffer());
}

function assertDigest(what: string, bytes: Uint8Array, expected: string): void {
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`${what} integrity mismatch: got ${actual}, expected ${expected}`);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeCache(path: string, bytes: Uint8Array): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
