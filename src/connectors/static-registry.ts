/**
 * `StaticRegistry` reads `ServerDetail[]` from a YAML or JSON file on
 * disk. It's the curated-services source we ship with the platform
 * (Asana, Notion, Granola, etc. — `catalog.yaml` next to this file)
 * and the operator-override registry (NB_REGISTRIES path entry, or the
 * deprecated `NB_CATALOG_PATH` shim).
 *
 * Wire format is the upstream MCP registry's `ServerDetail` shape.
 * Every entry is ajv-validated against the upstream schema before it
 * leaves the registry. Invalid entries are dropped with a logged
 * warning naming the source path and the entry name (or index, when
 * `name` is missing); the surviving subset flows to the aggregator.
 *
 * Distinguishing this from `MpakRegistry`: static entries are
 * curator-authored and pinned at deploy time; mpak entries are pulled
 * live from a remote registry. They share one shape and one consumer
 * (`DirectoryAggregator`).
 *
 * Top-level YAML/JSON shape:
 *
 *   YAML:  { servers: [ ServerDetail, ... ] }
 *   JSON:  { servers: [ ServerDetail, ... ] }
 *
 * Bare-array JSON (legacy `NB_CATALOG_PATH` contract) is also accepted
 * — operators upgrading without rewriting their override file land in
 * the same code path.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { log } from "../cli/log.ts";
import { projectServerDetailToDirectoryEntry } from "../registries/projection.ts";
import type {
  ConnectorRegistry,
  DirectoryEntry,
  ListEntriesContext,
  RegistryConfig,
} from "../registries/types.ts";
import {
  getNimbleBrainConnectorMeta,
  type ServerDetail,
  validateServerDetail,
} from "./server-detail.ts";

export class StaticRegistry implements ConnectorRegistry {
  /**
   * @param config Registry configuration carried into projected entries.
   * @param path Absolute path to the YAML/JSON file holding the
   *   `ServerDetail[]`. Read on every `listEntries()` call so operator
   *   edits to a mounted ConfigMap take effect without a restart.
   */
  constructor(
    public readonly config: RegistryConfig,
    private readonly path: string,
  ) {}

  async listEntries(ctx?: ListEntriesContext): Promise<DirectoryEntry[]> {
    const servers = readStaticServers(this.path);
    const out: DirectoryEntry[] = [];
    for (const s of servers) {
      const entry = projectServerDetailToDirectoryEntry(s, {
        registryId: this.config.id,
        registryType: this.config.type,
      });
      if (!entry) {
        log.warn(
          `[static-registry] ${this.path} entry "${s.name}" dropped — no installable packages or remotes`,
        );
        continue;
      }
      // For static-auth entries, ask the caller's workspace whether
      // the operator has configured the OAuth app yet. DCR entries
      // (no operator setup needed) leave the field undefined so the
      // UI doesn't render a meaningless badge.
      const meta = getNimbleBrainConnectorMeta(s);
      if (meta?.auth === "static" && meta.operatorSetup && ctx?.isOperatorConfigured) {
        entry.operatorConfigured = await ctx.isOperatorConfigured(
          entry.id,
          meta.operatorSetup.clientSecretKey,
        );
      }
      out.push(entry);
    }
    return out;
  }
}

/**
 * Load a `ServerDetail[]` from the given YAML or JSON file. Returns
 * the validated subset — invalid entries are dropped with a logged
 * warning. Unreadable / unparseable files return an empty array
 * (caller logs the failure inline).
 */
export function readStaticServers(path: string): ServerDetail[] {
  if (!existsSync(path)) {
    log.warn(`[static-registry] ${path}: file not found — returning empty`);
    return [];
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn(
      `[static-registry] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  let parsed: unknown;
  try {
    const ext = extname(path).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      parsed = Bun.YAML.parse(text);
    } else {
      parsed = JSON.parse(text);
    }
  } catch (err) {
    log.warn(
      `[static-registry] failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return validateStaticServers(parsed, path);
}

/**
 * Validate a parsed candidate. Accepts:
 *   - `{ servers: [ ... ] }`              (canonical YAML/JSON shape)
 *   - `[ ... ]`                            (legacy NB_CATALOG_PATH contract)
 *
 * Returns only the entries that pass the upstream `ServerDetail` ajv
 * schema. Invalid entries are dropped with a logged warning naming the
 * source path and the entry's `name` (or index when `name` is absent).
 */
export function validateStaticServers(parsed: unknown, source: string): ServerDetail[] {
  let raw: unknown[];
  if (Array.isArray(parsed)) {
    raw = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { servers?: unknown }).servers)
  ) {
    raw = (parsed as { servers: unknown[] }).servers;
  } else {
    log.warn(`[static-registry] ${source} did not yield a top-level 'servers' list or bare array`);
    return [];
  }

  const out: ServerDetail[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i];
    const tag = `${source}[${i}${candidateName(candidate) ? `:${candidateName(candidate)}` : ""}]`;
    const result = validateServerDetail(candidate);
    if (!result.valid) {
      log.warn(
        `[static-registry] ${tag} dropped — invalid ServerDetail: ${result.errors.join("; ")}`,
      );
      continue;
    }
    const detail = candidate as ServerDetail;
    if (seenNames.has(detail.name)) {
      log.warn(`[static-registry] ${tag} dropped — duplicate name "${detail.name}"`);
      continue;
    }
    seenNames.add(detail.name);
    out.push(detail);
  }
  return out;
}

function candidateName(c: unknown): string | undefined {
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
    return (c as { name: string }).name;
  }
  return undefined;
}
