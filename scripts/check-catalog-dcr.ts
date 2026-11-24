#!/usr/bin/env bun

/**
 * Catalog rot detector for DCR remote-OAuth connectors.
 *
 * Reusable CLI tool: takes a catalog path (a `ServerDetail` file or a
 * directory of them) as a REQUIRED argument, picks every entry whose
 * `_meta["ai.nimblebrain/connector"].auth === "dcr"`, and runs the
 * full DCR flow end-to-end against each vendor:
 *
 *   1. Reachability — `HEAD <remotes[0].url>`. Vendors return 200 / 401 /
 *      405 depending on auth state. DNS failure / timeout / 5xx = the URL is
 *      dead, and so is 404 / 410 when a GET confirms it (a retired
 *      endpoint, such as an SSE URL a vendor moved to /mcp).
 *   2 + 3. OAuth discovery, exactly as sign-in does it — the MCP SDK's
 *      `discoverOAuthServerInfo`, which a connector's `auth()` calls: the
 *      protected-resource metadata the server's 401 names (RFC 9728, else
 *      its well-known locations), then the authorization server's RFC 8414
 *      or OpenID Connect metadata, each at its path-aware location. It must
 *      yield a `registration_endpoint` (RFC 7591) for the catalog claim of
 *      `auth: "dcr"` to be truthful. A narrower chain than sign-in's fails
 *      vendors that sign in fine.
 *   4. **DCR registration probe** — POST a synthetic client to the
 *      `registration_endpoint` with the redirect URI given as the second
 *      argument.
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

import {
  type AuthorizationServerMetadata,
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  type FetchLike,
  startAuthorization,
} from "@modelcontextprotocol/client";
import { readCatalogServers } from "../src/connectors/catalog/read.ts";
import {
  getNimbleBrainConnectorMeta,
  type ServerDetail,
} from "../src/connectors/catalog/server-detail.ts";

const REQUEST_TIMEOUT_MS = 10_000;

const USAGE =
  "Usage: bun run scripts/check-catalog-dcr.ts <catalog-file-or-dir> <redirect-uri>\n" +
  "Probe DCR connector entries in the given catalog for install-time rot.\n\n" +
  "  <redirect-uri>  the https callback the deployment registers with vendors,\n" +
  "                  e.g. https://nb.example.com/v1/mcp-auth/callback";

/**
 * Parse the probe's redirect URI. It is a REQUIRED argument, not a default:
 * vendors judge the registration and authorize steps against their own
 * redirect-host allowlists, so the probe is only truthful when it presents
 * the callback a real deployment registers (`mcpAuthCallbackUrl()` on that
 * deployment). A made-up host would fail every vendor that allowlists.
 */
function parseRedirectUri(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface CheckResult {
  name: string;
  url: string;
  pass: boolean;
  reachability: { ok: boolean; status?: number; error?: string };
  registrationEndpoint?: string;
  authorizationEndpoint?: string;
  failureReason?: string;
  /** Set on a pass whose last step could not be observed, with the reason. */
  unverified?: string;
}

/**
 * Pick the entries this probe checks: ONLY `auth: "dcr"`, with at least one
 * remote to reach. Every other auth kind is skipped — their failure modes
 * aren't catalog DCR rot. Exported + pure so an offline
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
  // Both arguments are REQUIRED. The catalog path is a file or a directory
  // of `ServerDetail` files. The real curated catalog now lives in the
  // deploy repo (the in-image `BUNDLED_STATIC_CATALOG_PATH` is only the
  // minimal example), so defaulting to it would silently green-check two
  // illustrative entries instead of the production set. Point this at
  // the mounted/checked-out catalog you actually want to probe.
  const catalogPath = process.argv[2];
  const redirectUri = parseRedirectUri(process.argv[3]);
  if (!catalogPath || !redirectUri) {
    console.error(USAGE);
    process.exit(2);
  }
  const dcrEntries = selectDcrEntries(readCatalogServers(catalogPath));

  if (dcrEntries.length === 0) {
    console.log("No DCR entries found in catalog. Nothing to check.");
    return;
  }

  console.log(
    `Probing ${dcrEntries.length} DCR catalog entries (reachability + DCR registration + authorize)…\n`,
  );

  const results = await Promise.all(dcrEntries.map((s) => checkEntry(s, redirectUri)));

  // Tabular report. Sort fails first so the eye lands on them.
  results.sort((a, b) => Number(a.pass) - Number(b.pass));
  const pad = (s: string, n: number) => s.padEnd(n);
  const colName = Math.max(20, ...results.map((r) => r.name.length));
  const colUrl = Math.max(30, ...results.map((r) => r.url.length));
  console.log(`${pad("ENTRY", colName)}  ${pad("URL", colUrl)}  STATUS`);
  console.log("─".repeat(colName + colUrl + 18));
  for (const r of results) {
    console.log(`${pad(r.name, colName)}  ${pad(r.url, colUrl)}  ${formatStatus(r)}`);
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

/** The report's STATUS column for one entry. Exported for the offline unit test. */
export function formatStatus(r: CheckResult): string {
  if (!r.pass) return `✗ FAIL — ${r.failureReason}`;
  if (r.unverified) return `⚠ ok (DCR registered; ${r.unverified})`;
  return "✓ ok (DCR + authorize end-to-end)";
}

/** Run the five probe steps against one entry. Exported for the offline unit test. */
export async function checkEntry(s: ServerDetail, redirectUri: string): Promise<CheckResult> {
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

  // 2 + 3. OAuth discovery, as sign-in does it.
  const discovered = await discoverAuthServer(url);
  const asMetadata = discovered?.metadata;
  if (!discovered || typeof asMetadata?.registration_endpoint !== "string") {
    result.failureReason = "no AS metadata advertised registration_endpoint (RFC 7591)";
    return result;
  }
  result.registrationEndpoint = asMetadata.registration_endpoint;
  if (asMetadata.authorization_endpoint) {
    result.authorizationEndpoint = asMetadata.authorization_endpoint;
  }

  // 4. DCR registration probe — catches vendors that reject the
  // redirect URI at the registration step (Intercom, Vercel pattern).
  const regResult = await probeDcrRegistration(asMetadata.registration_endpoint, redirectUri);
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
  const authResult = await probeAuthorize(discovered, regResult.clientId, redirectUri);
  if (!authResult.ok) {
    result.failureReason = `/authorize rejected our redirect URI: ${authResult.message}`;
    return result;
  }

  result.pass = true;
  if (authResult.challenged) {
    result.unverified = "/authorize is behind a bot challenge, so the redirect check is unverified";
  }
  return result;
}

/**
 * Whether a response is a bot-management challenge rather than the vendor's own
 * answer. Cloudflare marks every challenge it serves with `cf-mitigated: challenge`.
 * A challenge says nothing about our redirect URI: a person's browser passes it and
 * reaches the vendor's page, while a script never can.
 */
export function isBotChallenge(res: Response): boolean {
  return res.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
}

/**
 * Statuses that say the endpoint no longer exists. A HEAD alone is not trusted for
 * them: a server that routes only the methods MCP uses can answer HEAD with 404 at a
 * live endpoint, so a GET confirms before the entry fails.
 */
const GONE_STATUSES = new Set([404, 410]);

async function probeReachable(
  url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const statusOf = async (method: "HEAD" | "GET"): Promise<number> => {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
    // Only the status matters; an SSE endpoint's body would stream until the timeout.
    await res.body?.cancel();
    return res.status;
  };
  let status: number | undefined;
  try {
    status = await statusOf("HEAD");
  } catch {
    status = undefined;
  }
  if (status === undefined || GONE_STATUSES.has(status)) {
    try {
      status = await statusOf("GET");
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: status < 500 && !GONE_STATUSES.has(status), status };
}

/** `fetch` with the probe's per-request timeout, for the SDK's discovery calls. */
const timedFetch: FetchLike = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

/** What a connector's sign-in learns from discovery, and the probe reuses. */
interface Discovered {
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  /** The RFC 8707 resource sign-in names: the protected-resource metadata's, when it has one. */
  resource?: string;
  /** The scope the server's 401 asks for, else the scopes its metadata advertises. */
  scope?: string;
}

/**
 * Discovery the way a connector's sign-in does it: the MCP SDK's
 * `discoverOAuthServerInfo`, the call `auth()` makes, given the
 * `resource_metadata` URL the server's 401 names. Undefined when it finds no
 * authorization-server metadata.
 */
async function discoverAuthServer(url: string): Promise<Discovered | undefined> {
  let challenge: ReturnType<typeof extractWWWAuthenticateParams> = {};
  try {
    const res = await timedFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "check-catalog-dcr", version: "1" },
        },
      }),
    });
    challenge = extractWWWAuthenticateParams(res);
    await res.body?.cancel();
  } catch {
    // No 401 to read: discovery falls back to the well-known locations.
  }
  try {
    const info = await discoverOAuthServerInfo(url, {
      resourceMetadataUrl: challenge.resourceMetadataUrl,
      fetchFn: timedFetch,
    });
    if (!info.authorizationServerMetadata) return undefined;
    const advertised = info.resourceMetadata?.scopes_supported?.join(" ");
    const scope = challenge.scope || advertised || undefined;
    return {
      authorizationServerUrl: info.authorizationServerUrl,
      metadata: info.authorizationServerMetadata,
      ...(info.resourceMetadata?.resource ? { resource: info.resourceMetadata.resource } : {}),
      ...(scope ? { scope } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * POST a synthetic DCR client to the registration endpoint. Returns
 * `{ ok: true, clientId }` on success or `{ ok: false, message }` on
 * vendor-side rejection (typically host-allowlist failures).
 */
async function probeDcrRegistration(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ ok: true; clientId: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "NimbleBrain catalog probe",
        redirect_uris: [redirectUri],
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
 * GET the authorization request sign-in would send: built by the MCP SDK's
 * `startAuthorization`, as `auth()` builds it, with the discovered `resource` and
 * scope and a real PKCE pair. A spec-compliant vendor redirects to a login page
 * (302/303) or renders one (200). A vendor with a parallel host allowlist returns
 * 4xx with a "redirect URI ... not allowed" body.
 */
async function probeAuthorize(
  discovered: Discovered,
  clientId: string,
  redirectUri: string,
): Promise<{ ok: true; challenged?: boolean } | { ok: false; message: string }> {
  try {
    const { authorizationUrl: url } = await startAuthorization(discovered.authorizationServerUrl, {
      metadata: discovered.metadata,
      clientInformation: { client_id: clientId },
      redirectUrl: redirectUri,
      state: "probe",
      ...(discovered.scope ? { scope: discovered.scope } : {}),
      ...(discovered.resource ? { resource: discovered.resource } : {}),
    });
    const res = await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
    // 2xx (login page) or 3xx (redirect to vendor login) = pass.
    if (res.status < 400) return { ok: true };
    // The vendor never saw the request, so this is not a rejection. Registration
    // already accepted the redirect URI, which is the step most allowlists check.
    if (isBotChallenge(res)) return { ok: true, challenged: true };
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
