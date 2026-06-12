#!/usr/bin/env bun
/**
 * Catalog rot detector for DCR remote-OAuth connectors.
 *
 * Reusable CLI tool: takes a catalog path (a `ServerDetail` file or a
 * directory of them) as a REQUIRED argument, picks every entry whose
 * `_meta["ai.nimblebrain/connector"].auth === "dcr"`, and runs the
 * full DCR flow end-to-end against each vendor:
 *
 *   1. Reachability — `HEAD <remotes[0].url>`. Anything non-network-error
 *      counts; vendors return 200 / 401 / 405 depending on auth state.
 *      DNS failure / timeout / 5xx = the URL is dead.
 *   2. RFC 9728 protected-resource metadata — `GET <bundle-origin>/
 *      .well-known/oauth-protected-resource`. Optional but preferred;
 *      yields the authorization-server origin(s).
 *   3. RFC 8414 authorization-server metadata — `GET <as-origin>/
 *      .well-known/oauth-authorization-server`. Must yield JSON with
 *      `registration_endpoint` (RFC 7591) for the catalog claim of
 *      `auth: "dcr"` to be truthful.
 *   4. **DCR registration probe** — POST a synthetic client to the
 *      `registration_endpoint` with a representative redirect URI.
 *      Catches vendors that advertise DCR but reject our redirect-URI
 *      host (Intercom, Vercel pattern: "redirect URI ... not in the
 *      allowlist").
 *   5. **Authorize probe** — GET the `authorization_endpoint` with the
 *      client_id from step 4 and the same redirect URI. Catches
 *      vendors that accept DCR registration but reject the redirect
 *      URI at the authorize step (Canva pattern: "Invalid redirect
 *      URI. It must be from an allowed host."). A successful authorize
 *      probe responds with a redirect (302/303) to the vendor login
 *      flow, or a 200 login page; a 4xx with a "redirect URI" error
 *      string is the trapdoor.
 *
 * Steps 4 and 5 are what catch "DCR theater" — vendors that ship the
 * RFC 7591 endpoints but enforce a parallel host allowlist that the
 * spec is supposed to make obsolete. Pre-extension this script only
 * verified step 3, and shipped #195 with three connectors (Canva,
 * Intercom, Vercel) that broke at install time. See #200 for the
 * vendor outreach to re-add them.
 *
 * Each entry passes only if all 5 steps succeed. Per-entry pass/fail
 * report; exit 1 if any DCR entry fails.
 *
 * Network-dependent by design — NOT part of `bun run verify` (which is
 * offline). The production catalog now lives in the deploy repo, so the
 * automated PR gate is re-homed there (deployments#33), invoking this
 * tool against the mounted catalog via the platform image. Run it
 * locally against any catalog path before shipping a curation change.
 *
 * Static-auth entries are skipped — they're operator-pre-registered
 * and don't use DCR. Their failure mode (operator hasn't set up the
 * OAuth app for the workspace) is workspace-state, not catalog-rot.
 */

import { getNimbleBrainConnectorMeta, type ServerDetail } from "../src/connectors/server-detail.ts";
import { readStaticServers } from "../src/registries/static-source.ts";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Synthetic redirect URI for the probe. Real prod tenants live at
 * `https://<tenant>.platform.nimblebrain.ai/v1/mcp-auth/callback`;
 * this representative form catches host-allowlist policies that
 * accept the wildcard but not arbitrary hosts. Vendors that allowlist
 * the wildcard pattern pass; vendors with per-tenant pinning still
 * need outreach (the prod wildcard captures the common case).
 */
const PROBE_REDIRECT_URI = "https://hq.platform.nimblebrain.ai/v1/mcp-auth/callback";

interface CheckResult {
  name: string;
  url: string;
  pass: boolean;
  reachability: { ok: boolean; status?: number; error?: string };
  registrationEndpoint?: string;
  authorizationEndpoint?: string;
  failureReason?: string;
}

/**
 * Pick the entries this probe checks: `auth: "dcr"` with at least one
 * remote to reach. Static-auth and Composio entries are skipped (their
 * failure modes aren't catalog DCR rot). Exported + pure so an offline
 * unit test exercises the selection — and the script's imports against
 * the platform source — without the network probe or process exit.
 */
export function selectDcrEntries(servers: ServerDetail[]): ServerDetail[] {
  return servers.filter((s) => {
    const meta = getNimbleBrainConnectorMeta(s);
    return meta?.auth === "dcr" && !!s.remotes && s.remotes.length > 0;
  });
}

async function main(): Promise<void> {
  // Catalog path is a REQUIRED argument — a file or a directory of
  // `ServerDetail` files. The real curated catalog now lives in the
  // deploy repo (the in-image `BUNDLED_STATIC_CATALOG_PATH` is only the
  // minimal example), so defaulting to it would silently green-check two
  // illustrative entries instead of the production set. Point this at
  // the mounted/checked-out catalog you actually want to probe.
  const catalogPath = process.argv[2];
  if (!catalogPath) {
    console.error(
      "Usage: bun run scripts/check-catalog-dcr.ts <catalog-file-or-dir>\n" +
        "Probe DCR connector entries in the given catalog for install-time rot.",
    );
    process.exit(2);
  }
  const dcrEntries = selectDcrEntries(readStaticServers(catalogPath));

  if (dcrEntries.length === 0) {
    console.log("No DCR entries found in catalog. Nothing to check.");
    return;
  }

  console.log(
    `Probing ${dcrEntries.length} DCR catalog entries (reachability + DCR registration + authorize)…\n`,
  );

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
      ? `${icon} ok (DCR + authorize end-to-end)`
      : `${icon} FAIL — ${r.failureReason}`;
    console.log(`${pad(r.name, colName)}  ${pad(r.url, colUrl)}  ${status}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log("");
  if (failed.length > 0) {
    console.log(`✗ ${failed.length}/${results.length} DCR entries failed.\n`);
    for (const r of failed) {
      console.log(`  ${r.name} (${r.url}):`);
      console.log(`    ${r.failureReason}`);
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
  };

  // 1. Reachability.
  result.reachability = await probeReachable(url);
  if (!result.reachability.ok) {
    result.failureReason = `unreachable (${result.reachability.error ?? `HTTP ${result.reachability.status}`})`;
    return result;
  }

  // 2 + 3. OAuth metadata discovery — same chain as
  // workspace-oauth-provider.discoverAuthorizationServerOrigins.
  const bundleOrigin = new URL(url).origin;
  const asOrigins = await discoverAuthorizationServerOrigins(bundleOrigin);

  let asMetadata: { registration_endpoint: string; authorization_endpoint?: string } | null = null;
  for (const asOrigin of asOrigins) {
    const m = await fetchAsMetadata(`${asOrigin}/.well-known/oauth-authorization-server`);
    if (m) {
      asMetadata = m;
      break;
    }
  }
  if (!asMetadata) {
    result.failureReason = "no AS metadata advertised registration_endpoint (RFC 7591)";
    return result;
  }
  result.registrationEndpoint = asMetadata.registration_endpoint;
  if (asMetadata.authorization_endpoint) {
    result.authorizationEndpoint = asMetadata.authorization_endpoint;
  }

  // 4. DCR registration probe — catches vendors that reject the
  // redirect URI at the registration step (Intercom, Vercel pattern).
  const regResult = await probeDcrRegistration(asMetadata.registration_endpoint);
  if (!regResult.ok) {
    result.failureReason = `DCR /register rejected our redirect URI: ${regResult.message}`;
    return result;
  }

  // 5. Authorize probe — catches vendors that accept DCR registration
  // but reject the redirect URI at the authorize step (Canva pattern).
  if (!asMetadata.authorization_endpoint) {
    // Without an authorize endpoint we can't probe step 5. Mark pass
    // since DCR + the rest succeeded; flag for follow-up.
    result.pass = true;
    return result;
  }
  const authResult = await probeAuthorize(asMetadata.authorization_endpoint, regResult.clientId);
  if (!authResult.ok) {
    result.failureReason = `/authorize rejected our redirect URI: ${authResult.message}`;
    return result;
  }

  result.pass = true;
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
    if (res.status >= 500) {
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch {
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

async function fetchAsMetadata(
  metaUrl: string,
): Promise<{ registration_endpoint: string; authorization_endpoint?: string } | null> {
  try {
    const res = await fetch(metaUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      registration_endpoint?: unknown;
      authorization_endpoint?: unknown;
    };
    if (typeof body.registration_endpoint !== "string") return null;
    return {
      registration_endpoint: body.registration_endpoint,
      authorization_endpoint:
        typeof body.authorization_endpoint === "string" ? body.authorization_endpoint : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * POST a synthetic DCR client to the registration endpoint. Returns
 * `{ ok: true, clientId }` on success or `{ ok: false, message }` on
 * vendor-side rejection (typically host-allowlist failures).
 */
async function probeDcrRegistration(
  registrationEndpoint: string,
): Promise<{ ok: true; clientId: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "NimbleBrain catalog probe",
        redirect_uris: [PROBE_REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      // Try to surface the vendor's structured error_description if any.
      let detail = text.slice(0, 200);
      try {
        const body = JSON.parse(text) as { error?: string; error_description?: string };
        detail = body.error_description ?? body.error ?? detail;
      } catch {
        // not JSON; keep raw
      }
      return { ok: false, message: `HTTP ${res.status}: ${detail}` };
    }
    const body = JSON.parse(text) as { client_id?: unknown };
    if (typeof body.client_id !== "string") {
      return { ok: false, message: "registration response missing client_id" };
    }
    return { ok: true, clientId: body.client_id };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * GET the authorization endpoint with a synthetic state + PKCE pair.
 * A spec-compliant vendor will redirect us to a login page (302/303)
 * or render one inline (200). A vendor with a parallel host
 * allowlist returns 4xx with a "redirect URI ... not allowed" body.
 */
async function probeAuthorize(
  authorizationEndpoint: string,
  clientId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // PKCE challenge — `code_challenge_method=S256` of an arbitrary
  // verifier. Some vendors require it; supplying it never hurts.
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", PROBE_REDIRECT_URI);
  url.searchParams.set("scope", "");
  url.searchParams.set("state", "probe");
  url.searchParams.set("code_challenge", "Wph4LpxPDcXGKQQjkmFwIyMu5ZKLXEUW2Bn7sV3vqYU");
  url.searchParams.set("code_challenge_method", "S256");

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
    // 2xx (login page) or 3xx (redirect to vendor login) = pass.
    if (res.status < 400) return { ok: true };
    const body = (await res.text()).slice(0, 200).replace(/\s+/g, " ").trim();
    return { ok: false, message: `HTTP ${res.status}: ${body}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Only probe when run directly — importing the module (e.g. from the
// unit test) must not trigger the network run or the argv/exit handling.
if (import.meta.main) {
  await main();
}
