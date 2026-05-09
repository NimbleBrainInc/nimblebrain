#!/usr/bin/env bun
/**
 * Catalog rot detector for DCR remote-OAuth connectors.
 *
 * Iterates `src/connectors/catalog.yaml`, picks every entry whose
 * `_meta["ai.nimblebrain/connector"].auth === "dcr"`, and runs the
 * same OAuth-discovery chain the production platform uses
 * (`src/tools/workspace-oauth-provider.ts`):
 *
 *   1. Reachability — `HEAD <remotes[0].url>`. Anything non-network-error
 *      counts; vendors return 200 / 401 / 405 depending on auth state.
 *      DNS failure / timeout / 5xx = the URL is dead.
 *   2. RFC 9728 protected-resource metadata — `GET <bundle-origin>/
 *      .well-known/oauth-protected-resource`. Optional but preferred;
 *      yields the authorization-server origin(s).
 *   3. RFC 8414 authorization-server metadata — `GET <as-origin>/
 *      .well-known/oauth-authorization-server` against each candidate
 *      AS origin (RFC 9728 advertised, plus bundle origin as fallback).
 *      Must yield JSON with `registration_endpoint` (RFC 7591) for the
 *      catalog claim of `auth: "dcr"` to be truthful.
 *
 * Each entry passes if at least one candidate AS yields a metadata
 * document with `registration_endpoint`. Per-entry pass/fail report;
 * exit 1 if any DCR entry fails.
 *
 * Network-dependent by design — NOT part of `bun run verify` (which is
 * offline). Run before merging catalog.yaml changes; CI runs it
 * automatically on PRs that touch the file (`.github/workflows/catalog-check.yml`).
 *
 * Static-auth entries are skipped — they're operator-pre-registered and
 * don't use DCR. Their failure mode (operator hasn't set up the OAuth
 * app for the workspace) is workspace-state, not catalog-rot.
 */

import { readStaticServers } from "../src/registries/static-source.ts";
import { BUNDLED_STATIC_CATALOG_PATH } from "../src/registries/registry-store.ts";
import { getNimbleBrainConnectorMeta, type ServerDetail } from "../src/connectors/server-detail.ts";

const REQUEST_TIMEOUT_MS = 10_000;

interface CheckResult {
  name: string;
  url: string;
  pass: boolean;
  reachability: { ok: boolean; status?: number; error?: string };
  registrationEndpoint?: string;
  metadataAttempts: Array<{ url: string; ok: boolean; status?: number; error?: string }>;
  failureReason?: string;
}

async function main(): Promise<void> {
  const servers = readStaticServers(BUNDLED_STATIC_CATALOG_PATH);
  const dcrEntries: ServerDetail[] = [];
  for (const s of servers) {
    const meta = getNimbleBrainConnectorMeta(s);
    if (meta?.auth === "dcr" && s.remotes && s.remotes.length > 0) {
      dcrEntries.push(s);
    }
  }

  if (dcrEntries.length === 0) {
    console.log("No DCR entries found in catalog. Nothing to check.");
    return;
  }

  console.log(`Probing ${dcrEntries.length} DCR catalog entries…\n`);

  const results = await Promise.all(dcrEntries.map(checkEntry));

  // Tabular report. Sort fails first so the eye lands on them.
  results.sort((a, b) => Number(a.pass) - Number(b.pass));
  const pad = (s: string, n: number) => s.padEnd(n);
  const colName = Math.max(20, ...results.map((r) => r.name.length));
  const colUrl = Math.max(30, ...results.map((r) => r.url.length));
  console.log(`${pad("ENTRY", colName)}  ${pad("URL", colUrl)}  STATUS`);
  console.log("─".repeat(colName + colUrl + 18));
  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    const status = r.pass
      ? `${icon} ok (registration_endpoint=${r.registrationEndpoint})`
      : `${icon} FAIL — ${r.failureReason}`;
    console.log(`${pad(r.name, colName)}  ${pad(r.url, colUrl)}  ${status}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("");
  if (failed.length > 0) {
    console.log(`✗ ${failed.length}/${results.length} DCR entries failed.\n`);
    for (const r of failed) {
      console.log(`  ${r.name} (${r.url}):`);
      console.log(`    reachability: ${r.reachability.ok ? "ok" : `failed — ${r.reachability.error ?? r.reachability.status}`}`);
      for (const m of r.metadataAttempts) {
        console.log(`    metadata ${m.url}: ${m.ok ? "ok" : `failed — ${m.error ?? m.status}`}`);
      }
    }
    process.exit(1);
  }
  console.log(`✓ All ${results.length} DCR entries pass.`);
}

async function checkEntry(s: ServerDetail): Promise<CheckResult> {
  const url = s.remotes![0]!.url;
  const result: CheckResult = {
    name: s.name,
    url,
    pass: false,
    reachability: { ok: false },
    metadataAttempts: [],
  };

  // 1. Reachability — any non-network-error response counts.
  result.reachability = await probeReachable(url);
  if (!result.reachability.ok) {
    result.failureReason = `unreachable (${result.reachability.error ?? `HTTP ${result.reachability.status}`})`;
    return result;
  }

  // 2 + 3. OAuth metadata discovery — same chain as
  // workspace-oauth-provider.discoverAuthorizationServerOrigins:
  // try RFC 9728 first to find advertised AS origin(s), always fall
  // back to the bundle origin.
  const bundleOrigin = new URL(url).origin;
  const asOrigins = await discoverAuthorizationServerOrigins(bundleOrigin);

  for (const asOrigin of asOrigins) {
    const metaUrl = `${asOrigin}/.well-known/oauth-authorization-server`;
    const attempt = await probeMetadata(metaUrl);
    result.metadataAttempts.push(attempt);
    if (attempt.ok && attempt.registrationEndpoint) {
      result.pass = true;
      result.registrationEndpoint = attempt.registrationEndpoint;
      return result;
    }
  }

  result.failureReason =
    "no AS metadata advertised registration_endpoint (RFC 7591)";
  return result;
}

async function probeReachable(
  url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
    // 2xx, 3xx, 4xx all mean the URL is responding. 5xx = vendor down.
    if (res.status >= 500) {
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    // Some servers reject HEAD with a transport error. Retry with GET
    // before giving up — this catches CDNs that 405 HEAD and Bun-side
    // protocol mismatches that look like network errors.
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "manual",
      });
      if (res.status >= 500) return { ok: false, status: res.status };
      return { ok: true, status: res.status };
    } catch (err2) {
      return { ok: false, error: err2 instanceof Error ? err2.message : String(err2) };
    }
  }
}

async function discoverAuthorizationServerOrigins(bundleOrigin: string): Promise<string[]> {
  const origins = new Set<string>();
  try {
    const prMetadataUrl = `${bundleOrigin}/.well-known/oauth-protected-resource`;
    const res = await fetch(prMetadataUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { authorization_servers?: unknown };
      if (Array.isArray(body.authorization_servers)) {
        for (const entry of body.authorization_servers) {
          if (typeof entry !== "string") continue;
          try {
            origins.add(new URL(entry).origin);
          } catch {
            // malformed AS entry — ignore
          }
        }
      }
    }
  } catch {
    // RFC 9728 not advertised — bundle origin fallback below covers it.
  }
  origins.add(bundleOrigin);
  return [...origins];
}

async function probeMetadata(metaUrl: string): Promise<{
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
  registrationEndpoint?: string;
}> {
  try {
    const res = await fetch(metaUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { url: metaUrl, ok: false, status: res.status };
    const body = (await res.json()) as { registration_endpoint?: unknown };
    if (typeof body.registration_endpoint !== "string") {
      return { url: metaUrl, ok: false, status: res.status, error: "no registration_endpoint" };
    }
    return {
      url: metaUrl,
      ok: true,
      status: res.status,
      registrationEndpoint: body.registration_endpoint,
    };
  } catch (err) {
    return {
      url: metaUrl,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

await main();
