/**
 * Connector-skill overlay resolver.
 *
 * Connector "overlays" are short usage-guidance skills that NimbleBrain curates
 * for connectors we don't control (Composio + other third-party MCP servers).
 * They live in a public, curated repo keyed by connector identity:
 *
 *     <repo>/<identity>/SKILL.md      e.g.  connector-skills/gmail/SKILL.md
 *
 * This module fetches an overlay by identity from the repo at a PINNED version,
 * records its sha256 (provenance / tamper-evidence), and content-addresses the
 * result on disk so one connector installed across N workspaces fetches once.
 *
 * Fail-closed: a missing overlay (404) is a no-op (`null`); any other non-2xx,
 * a network error, or a declared-integrity mismatch THROWS. The caller treats a
 * resolve failure as non-fatal to the connector (the overlay is optional) but
 * must never silently materialize tampered or partial content.
 *
 * Pure-ish + injectable: `fetchImpl` and `cacheDir` are parameters so the unit
 * tests run against a fixture with no network and a temp cache.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONNECTOR_SKILLS_REPO_DEFAULT,
  CONNECTOR_SKILLS_VERSION_DEFAULT,
} from "../config/connector-skills.ts";

export interface ResolvedOverlay {
  /** The SKILL.md body, verbatim. */
  body: string;
  /** sha256 of the body (hex) — recorded for provenance / tamper-evidence. */
  sha: string;
}

export interface ResolveOverlayOptions {
  /** Directory for the content-addressed cache (e.g. `{workDir}/cache/connector-skills`). */
  cacheDir: string;
  /** owner/repo of the curated overlay repo. Defaults to {@link CONNECTOR_SKILLS_REPO_DEFAULT}. */
  repo?: string;
  /** Pinned git tag/sha. Defaults to {@link CONNECTOR_SKILLS_VERSION_DEFAULT}. */
  version?: string;
  /** Injectable fetch — defaults to global `fetch`. Tests pass a fixture. */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms). Default 15000. */
  timeoutMs?: number;
  /**
   * If set, the resolved body's sha256 must equal this or resolution fails
   * closed. Used when a caller already pinned an integrity hash (e.g. a
   * recorded `skillsLock` entry on re-resolve).
   */
  expectedSha?: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** raw.githubusercontent.com URL for `<identity>/SKILL.md` at the pinned version. */
export function overlayUrl(repo: string, version: string, identity: string): string {
  return `https://raw.githubusercontent.com/${repo}/${version}/${identity}/SKILL.md`;
}

/**
 * Resolve a curated connector-skill overlay by connector identity
 * (e.g. `"gmail"`) from the public overlay repo at a pinned version.
 *
 * @returns the `{ body, sha }`, or `null` when no overlay is curated for this
 *   connector (HTTP 404). Throws on any other failure (fail-closed).
 */
export async function resolveOverlay(
  identity: string,
  opts: ResolveOverlayOptions,
): Promise<ResolvedOverlay | null> {
  const repo = opts.repo ?? CONNECTOR_SKILLS_REPO_DEFAULT;
  const version = opts.version ?? CONNECTOR_SKILLS_VERSION_DEFAULT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  // Cache key spans (identity, repo, version) so a version bump or repo change
  // re-resolves rather than serving stale content. The body's own sha is
  // recorded inside the cache entry for provenance. NOTE: this assumes pinned
  // versions are immutable — moving a tag (e.g. re-pointing `v0.1.0`) under a
  // fixed key serves the cached body until the cache dir is cleared. Bump the
  // version to roll forward; don't re-point a tag.
  const cacheKey = sha256Hex(`${identity}@${repo}@${version}`);
  const cachePath = join(opts.cacheDir, `${cacheKey}.json`);

  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { miss: true } | ResolvedOverlay;
    const result = "miss" in cached ? null : cached;
    assertIntegrity(identity, result, opts.expectedSha);
    return result;
  }

  const url = overlayUrl(repo, version, identity);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });

  // 404 — no overlay curated for this connector. Cache the miss so repeated
  // installs across workspaces don't re-hit the network, then no-op.
  if (res.status === 404) {
    writeCache(cachePath, { miss: true });
    return null;
  }
  // Any other non-2xx is fail-closed: do NOT cache, do NOT materialize.
  if (!res.ok) {
    throw new Error(`connector-skill fetch failed for "${identity}": HTTP ${res.status} (${url})`);
  }

  const body = await res.text();
  const resolved: ResolvedOverlay = { body, sha: sha256Hex(body) };
  assertIntegrity(identity, resolved, opts.expectedSha);
  writeCache(cachePath, resolved);
  return resolved;
}

function assertIntegrity(
  identity: string,
  result: ResolvedOverlay | null,
  expectedSha: string | undefined,
): void {
  if (result && expectedSha && result.sha !== expectedSha) {
    throw new Error(
      `connector-skill integrity mismatch for "${identity}": got ${result.sha}, expected ${expectedSha}`,
    );
  }
}

function writeCache(cachePath: string, value: { miss: true } | ResolvedOverlay): void {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(value), "utf8");
}
