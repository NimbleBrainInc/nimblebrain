/**
 * What one catalog item installs, read from its verified artifact (ADR-0077,
 * install steps 2 to 4). Nothing here reads a listing's display fields or its
 * extension: an entry selects (`url`, `digest`, inline `data`) and the
 * artifact decides.
 *
 * - **Fetched and verified.** A `url` artifact is fetched through the bounded
 *   fetch and used only when its bytes hash to the entry's `digest`; inline
 *   `data` is verified over its canonical form (RFC 8785). An entry with no
 *   `digest` is not installable.
 * - **Cached by digest.** Verified bytes are kept under
 *   `cache/plugins/<algorithm>-<hex>`, read back only when they still hash to
 *   it, so an install, a reinstall and every owner share one fetch.
 * - **Read as a plugin.** An Agent Plugin archive is validated by the one
 *   manifest reader (`src/plugins/manifest.ts`); a `stdio` server refuses the
 *   install. Each server's record is the archive's
 *   `ai.nimblebrain/servers/<key>.json`, a `ServerDetail`, validated and
 *   scrubbed as the connector list's records are.
 * - **One item, one plugin.** A bare connector (its inline `server.json`
 *   record) and a bare skill (a skills zip or one `SKILL.md`) read as a
 *   one-item plugin with a generated manifest, so install has one shape.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_TYPES, SERVER_RECORD_TYPE, SKILL_TYPES } from "../../catalogs/listing.ts";
import {
  projectServerDetailToCatalogListing,
  validateServerDetailSafety,
} from "../../connectors/catalog/projection.ts";
import { type ServerDetail, validateServerDetail } from "../../connectors/catalog/server-detail.ts";
import { parseFrontmatter } from "../../skills/frontmatter.ts";
import { canonicalJsonBytes } from "../../util/jcs.ts";
import { fetchBounded } from "../../util/pinned-fetch.ts";
import { readZip, ZIP_MAX_TOTAL_BYTES } from "../../util/zip.ts";
import type { ConversationStarter } from "../extension.ts";
import { MCP_CONFIG_FILE, PLUGIN_MANIFEST_FILE, parsePluginManifest } from "../manifest.ts";

/** The most bytes fetched for one artifact: the archive expansion budget plus ZIP metadata. */
export const MAX_ARTIFACT_BYTES = ZIP_MAX_TOTAL_BYTES + 1024 * 1024;

/** Where an archive keeps each server's record. */
export const SERVER_RECORD_DIR = "ai.nimblebrain/servers";

/** The entry fields install reads: what it selects, never what it shows. */
export interface ArtifactSelection {
  address: string;
  /** The item's short name in its catalog, the generated manifest's name for a bare item. */
  name: string;
  type: string;
  url?: string;
  data?: unknown;
  digest?: string;
}

/** One server a plugin connects: its key in the plugin, its registry name, its record. */
export interface PluginServerRecord {
  key: string;
  name: string;
  detail: ServerDetail;
}

/** One skill a plugin carries, with the server key it binds to when it names one. */
export interface PluginSkillFile {
  name: string;
  server?: string;
  body: string;
}

/** What a verified artifact installs. */
export interface PluginContents {
  /** The manifest's name, or the item's for a generated manifest. */
  name: string;
  servers: PluginServerRecord[];
  skills: PluginSkillFile[];
  starters: ConversationStarter[];
}

/** An artifact that cannot be installed, with why. */
export class ArtifactError extends Error {
  constructor(
    readonly code: "NO_DIGEST" | "FETCH_FAILED" | "DIGEST_MISMATCH" | "INVALID" | "STDIO_SERVER",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface ArtifactOptions {
  /** `{workDir}/cache/plugins`. */
  cacheDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The verified bytes of an entry's artifact: from the cache, the inline data, or one fetch. */
export async function obtainArtifact(
  entry: ArtifactSelection,
  opts: ArtifactOptions,
): Promise<{ bytes: Uint8Array; digest: string; fetched: boolean }> {
  const digest = entry.digest;
  if (!digest) {
    throw new ArtifactError(
      "NO_DIGEST",
      `${entry.address} has no digest in its listing, so what it installs cannot be verified`,
    );
  }
  const [algorithm, hex] = digest.split(":") as [string, string];
  if (entry.data !== undefined) {
    const bytes = canonicalJsonBytes(entry.data);
    assertDigest(entry.address, bytes, algorithm, hex);
    return { bytes, digest, fetched: false };
  }
  const cacheFile = join(opts.cacheDir, `${algorithm}-${hex}`);
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile);
    if (hashOf(algorithm, cached) === hex) return { bytes: cached, digest, fetched: false };
  }
  let bytes: Uint8Array;
  try {
    bytes = await fetchBounded(entry.url as string, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? 15_000,
      maxBytes: MAX_ARTIFACT_BYTES,
    });
  } catch (err) {
    throw new ArtifactError(
      "FETCH_FAILED",
      `${entry.address} could not be fetched from ${entry.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertDigest(entry.address, bytes, algorithm, hex);
  writeCache(cacheFile, bytes);
  return { bytes, digest, fetched: true };
}

function hashOf(algorithm: string, bytes: Uint8Array): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

function assertDigest(address: string, bytes: Uint8Array, algorithm: string, hex: string): void {
  const actual = hashOf(algorithm, bytes);
  if (actual !== hex) {
    throw new ArtifactError(
      "DIGEST_MISMATCH",
      `${address}: the artifact does not match its digest (got ${algorithm}:${actual}, expected ${algorithm}:${hex}); nothing was installed`,
    );
  }
}

/** Write through a temporary file, so a reader never sees a partial copy. Best-effort. */
function writeCache(path: string, bytes: Uint8Array): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch {
    // A cache that cannot be written costs a refetch, nothing more.
  }
}

/** Read verified bytes as the plugin they install. Throws `ArtifactError`. */
export function readArtifact(entry: ArtifactSelection, bytes: Uint8Array): PluginContents {
  if (PLUGIN_TYPES.includes(entry.type)) return readPluginArchive(entry.address, bytes);
  if (entry.type === SERVER_RECORD_TYPE) return bareConnector(entry, bytes);
  if (SKILL_TYPES.includes(entry.type)) return bareSkill(entry, bytes);
  throw new ArtifactError(
    "INVALID",
    `${entry.address} is a ${entry.type}, which cannot be installed`,
  );
}

function invalid(address: string, why: string): ArtifactError {
  return new ArtifactError("INVALID", `${address}: ${why}`);
}

/** An Agent Plugin archive: its manifest strictly, each server's record, its skills and starters. */
function readPluginArchive(address: string, bytes: Uint8Array): PluginContents {
  let files: Map<string, Uint8Array>;
  try {
    files = readZip(bytes);
  } catch (err) {
    throw invalid(address, `the archive cannot be read (${(err as Error).message})`);
  }
  // Claude Code keeps its manifest at `.claude-plugin/plugin.json`.
  const claude = files.get(".claude-plugin/plugin.json");
  if (!files.has(PLUGIN_MANIFEST_FILE) && claude) files.set(PLUGIN_MANIFEST_FILE, claude);
  let manifest: ReturnType<typeof parsePluginManifest>;
  try {
    manifest = parsePluginManifest(address, files, { root: "/plugin", data: "/plugin-data" });
  } catch (err) {
    // The manifest reader's message names the plugin, the file and each field.
    throw new ArtifactError("INVALID", (err as Error).message);
  }
  for (const [key, server] of Object.entries(manifest.mcpServers)) {
    if (server.type === "stdio") {
      throw new ArtifactError(
        "STDIO_SERVER",
        `${address} runs its server "${key}" locally (stdio), and NimbleBrain reaches servers only over the network; the plugin's author has to offer it as a remote MCP server`,
      );
    }
  }
  const keys = [
    ...new Set([...Object.keys(manifest.mcpServers), ...Object.keys(manifest.extension.servers)]),
  ].sort();
  const servers = keys.map((key) =>
    serverRecord(address, key, manifest.extension.servers[key], files),
  );
  const skills: PluginSkillFile[] = [];
  for (const folder of manifest.skills) {
    const raw = files.get(`${folder}/SKILL.md`);
    if (!raw) continue;
    const body = new TextDecoder().decode(raw);
    const bound = boundServer(body);
    skills.push({
      name: folder.slice("skills/".length),
      ...(bound && keys.includes(bound) ? { server: bound } : {}),
      body,
    });
  }
  return {
    name: manifest.name,
    servers,
    skills,
    starters: manifest.extension.conversationStarters,
  };
}

/** The record of server `key`, from the archive, checked against the name the manifest gives it. */
function serverRecord(
  address: string,
  key: string,
  named: string | undefined,
  files: Map<string, Uint8Array>,
): PluginServerRecord {
  const path = `${SERVER_RECORD_DIR}/${key}.json`;
  const raw = files.get(path);
  if (!raw) throw invalid(address, `its server "${key}" has no record at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (err) {
    throw invalid(address, `${path} is not JSON (${(err as Error).message})`);
  }
  const detail = checkedServerDetail(address, path, parsed);
  if (named !== undefined && named !== detail.name) {
    throw invalid(address, `${path} is "${detail.name}", but plugin.json names "${named}"`);
  }
  return { key, name: detail.name, detail };
}

/** A `ServerDetail` the connector list would accept and install, or throw. */
function checkedServerDetail(address: string, where: string, raw: unknown): ServerDetail {
  const validation = validateServerDetail(raw);
  if (!validation.valid) {
    throw invalid(address, `${where} is not a server record: ${validation.errors.join("; ")}`);
  }
  const detail = raw as ServerDetail;
  const unsafe = validateServerDetailSafety(detail);
  if (unsafe) throw invalid(address, `${where} is refused: ${unsafe}`);
  if (!projectServerDetailToCatalogListing(detail)) {
    throw invalid(
      address,
      `${where} names no remote this host can reach (a ${MCP_CONFIG_FILE} or packages-only server)`,
    );
  }
  return detail;
}

/** The server key a skill's frontmatter binds it to, when it names one. */
function boundServer(body: string): string | undefined {
  try {
    const meta = parseFrontmatter(body).data.metadata as Record<string, unknown> | undefined;
    const nb = meta?.nimblebrain as Record<string, unknown> | undefined;
    return typeof nb?.server === "string" ? nb.server : undefined;
  } catch {
    return undefined;
  }
}

/** A connector listed on its own: one server, keyed by the item's name. */
function bareConnector(entry: ArtifactSelection, bytes: Uint8Array): PluginContents {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw invalid(entry.address, `the server record is not JSON (${(err as Error).message})`);
  }
  const detail = checkedServerDetail(entry.address, "its server record", raw);
  return {
    name: entry.name,
    servers: [{ key: entry.name, name: detail.name, detail }],
    skills: [],
    starters: [],
  };
}

/** A skill listed on its own: a skills zip (one `SKILL.md`) or the `SKILL.md` itself. */
function bareSkill(entry: ArtifactSelection, bytes: Uint8Array): PluginContents {
  let body: string;
  if (entry.type.endsWith("+zip")) {
    let files: Map<string, Uint8Array>;
    try {
      files = readZip(bytes);
    } catch (err) {
      throw invalid(entry.address, `the archive cannot be read (${(err as Error).message})`);
    }
    const found = [...files.keys()].filter((p) => /^(?:[^/]+\/)?SKILL\.md$/.test(p));
    if (found.length !== 1) {
      throw invalid(
        entry.address,
        `a skill archive holds one SKILL.md; this one holds ${found.length}`,
      );
    }
    body = new TextDecoder().decode(files.get(found[0] as string));
  } else if (entry.data !== undefined) {
    // Inline: the canonical form of a JSON string is the string, quoted.
    if (typeof entry.data !== "string")
      throw invalid(entry.address, "inline data is not a SKILL.md");
    body = entry.data;
  } else {
    body = new TextDecoder().decode(bytes);
  }
  return { name: entry.name, servers: [], skills: [{ name: entry.name, body }], starters: [] };
}
