/**
 * `StaticSource` reads `ServerDetail[]` from a YAML or JSON file on
 * disk. It's the curated-services source we ship with the platform
 * (Asana, Notion, Granola, etc. — `src/connectors/catalog.yaml`) and
 * the operator-override source (NB_REGISTRIES path entry, or the
 * deprecated `NB_CATALOG_PATH` shim).
 *
 * The contract is just `fetch(): Promise<ServerDetail[]>`. Filtering,
 * projection, error aggregation, and lookup tables live in
 * `ConnectorDirectory` — this class is a pure file-to-validated-records
 * adapter. Re-reads on every call so operator edits to a mounted
 * ConfigMap take effect without a restart.
 *
 * Wire format is the upstream MCP registry's `ServerDetail` shape
 * (see `src/connectors/server-detail.ts`). Every entry is ajv-validated
 * before it leaves the source. Invalid entries are dropped with a
 * logged warning naming the source path and the entry name (or index,
 * when `name` is missing); the surviving subset flows up.
 *
 * Top-level YAML/JSON shape:
 *
 *   YAML:  { servers: [ ServerDetail, ... ] }
 *   JSON:  { servers: [ ServerDetail, ... ] }
 *
 * Bare-array JSON (legacy `NB_CATALOG_PATH` contract) is also
 * accepted — operators upgrading without rewriting their override file
 * land in the same code path.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { log } from "../cli/log.ts";
import {
  getNimbleBrainConnectorMeta,
  type ServerDetail,
  validateServerDetail,
} from "../connectors/server-detail.ts";
import { validateAdditionalAuthorizationParams } from "../tools/workspace-oauth-provider.ts";
import { isHttpUrl } from "../util/url.ts";
import type { ConnectorSource } from "./types.ts";

export class StaticSource implements ConnectorSource {
  /**
   * @param id Stable source id (from `RegistryConfig.id`) — used by
   *   the directory in error-tagged log lines.
   * @param path Absolute path to the YAML/JSON file holding the
   *   `ServerDetail[]`. Read on every `fetch()` call so operator
   *   edits to a mounted ConfigMap take effect without a restart.
   */
  constructor(
    public readonly id: string,
    private readonly path: string,
  ) {}

  async fetch(): Promise<ServerDetail[]> {
    return readStaticServers(this.path);
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
    log.warn(`[static-source] ${path}: file not found — returning empty`);
    return [];
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    log.warn(
      `[static-source] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
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
      `[static-source] failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
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
 * schema and the platform's defense-in-depth safety checks.
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
    log.warn(`[static-source] ${source} did not yield a top-level 'servers' list or bare array`);
    return [];
  }

  const out: ServerDetail[] = [];
  const seenNames = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i];
    const name = candidateName(candidate);
    const tag = `${source}[${i}${name ? `:${name}` : ""}]`;
    const result = validateServerDetail(candidate);
    if (!result.valid) {
      log.warn(
        `[static-source] ${tag} dropped — invalid ServerDetail: ${result.errors.join("; ")}`,
      );
      continue;
    }
    const detail = candidate as ServerDetail;
    if (seenNames.has(detail.name)) {
      log.warn(`[static-source] ${tag} dropped — duplicate name "${detail.name}"`);
      continue;
    }
    // Defense-in-depth checks the upstream ajv schema doesn't perform:
    //
    //   - `format: "uri"` accepts any syntactically valid URI, including
    //     `javascript:` / `vbscript:` / `file:` — those would XSS the
    //     Browse page's `<img src>` or the Set-up modal's `<a href>` if a
    //     malicious operator-supplied catalog landed.
    //   - reserved OAuth params (`client_id`, `redirect_uri`, `state`, ...)
    //     in `additionalAuthorizationParams` would let a catalog author
    //     silently override the OAuth flow at runtime; the lifecycle
    //     installer rejects them later, but failing here gives a clearer
    //     source-tagged warning.
    const safetyError = validateNimbleBrainSafety(detail);
    if (safetyError) {
      log.warn(`[static-source] ${tag} dropped — ${safetyError}`);
      continue;
    }
    seenNames.add(detail.name);
    out.push(detail);
  }
  return out;
}

/**
 * Run the safety checks the upstream schema can't (URL scheme allowlist
 * for icon / portal URLs, reserved-key allowlist for additionalAuthorizationParams).
 * Returns the first violation message, or null when the entry is safe.
 */
function validateNimbleBrainSafety(s: ServerDetail): string | null {
  for (const icon of s.icons ?? []) {
    if (!isHttpUrl(icon.src)) {
      return `icon src must be http(s): "${icon.src}"`;
    }
  }
  const meta = getNimbleBrainConnectorMeta(s);
  if (meta?.operatorSetup) {
    if (!isHttpUrl(meta.operatorSetup.portalUrl)) {
      return `operatorSetup.portalUrl must be http(s): "${meta.operatorSetup.portalUrl}"`;
    }
  }
  if (meta?.additionalAuthorizationParams) {
    try {
      validateAdditionalAuthorizationParams(meta.additionalAuthorizationParams);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (meta?.docsUrl !== undefined && !isHttpUrl(meta.docsUrl)) {
    return `docsUrl must be http(s): "${meta.docsUrl}"`;
  }
  return null;
}

function candidateName(c: unknown): string | undefined {
  if (c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string") {
    return (c as { name: string }).name;
  }
  return undefined;
}
