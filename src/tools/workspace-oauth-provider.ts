import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { validateBundleUrl } from "../bundles/url-validator.ts";
import { log } from "../cli/log.ts";

/**
 * Thrown from `redirectToAuthorization` when a remote MCP server requires
 * interactive browser-based OAuth. Caught by `McpSource.start()` and surfaced
 * as a clear startup failure. Resolving this properly is a follow-up; for
 * now it fails fast rather than hanging on a flow that can't complete
 * headlessly.
 */
export class InteractiveOAuthNotSupportedError extends Error {
  constructor(public readonly authorizationUrl: string) {
    super(
      `Interactive OAuth not yet supported in this build. The remote MCP server ` +
        `requires browser authorization at:\n  ${authorizationUrl}\n` +
        `Only headless flows (e.g. Reboot's Anonymous dev provider) are supported today.`,
    );
    this.name = "InteractiveOAuthNotSupportedError";
  }
}

export interface WorkspaceOAuthProviderOptions {
  wsId: string;
  serverName: string;
  workDir: string;
  /** Absolute callback URL — must match the /v1/mcp-auth/callback route. */
  callbackUrl: string;
  /**
   * Whether loopback / RFC1918 / cloud-metadata hosts are acceptable targets
   * for the authorize chain. Mirrors the platform-level `allowInsecureRemotes`
   * flag; when `false` (production default), every hop of the authorize
   * redirect chain is passed through `validateBundleUrl` to block SSRF
   * against internal infrastructure (AWS IMDS, RFC1918 admin panels,
   * NimbleBrain's own loopback ports).
   */
  allowInsecureRemotes?: boolean;
}

/**
 * Normalize a callback URL to a `{origin, pathname}` canonical form so the
 * self-match check tolerates trivial differences a strict `===` would miss:
 * trailing slash on pathname, explicit default port vs implicit, hostname
 * case. The pathname is stripped of trailing `/` and compared case-sensitively
 * (paths are case-sensitive); the origin is lowercased.
 */
function canonicalEndpoint(u: URL): string {
  const origin = u.origin.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return `${origin}${path}`;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * File-backed OAuthClientProvider scoped to a `(workspace, serverName)`
 * pair. Persistence layout:
 *
 *   <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/
 *     ├── client.json    — DCR result (OAuthClientInformationFull)
 *     ├── tokens.json    — OAuthTokens (access + refresh)
 *     └── verifier.json  — PKCE verifier (ephemeral; deleted after finishAuth)
 *
 * Directory is created with mode 0o700; files are written 0o600 via an
 * atomic rename pattern (write to tmp, chmod, rename). Same discipline as
 * `src/config/workspace-credentials.ts`.
 *
 * For Reboot's `Anonymous` dev OAuth (rbt dev): the authorization URL
 * returned by the server is ALREADY our own callback URL with
 * `?code=anonymous&state=...` embedded (see
 * `reboot/aio/auth/oauth_providers.py:278-281`). We detect the self-target
 * in `redirectToAuthorization` and resolve the pending flow in-process —
 * no HTTP round-trip, no browser. For all other interactive flows, we
 * throw `InteractiveOAuthNotSupportedError` and fail fast.
 */
export class WorkspaceOAuthProvider implements OAuthClientProvider {
  private readonly wsId: string;
  private readonly serverName: string;
  private readonly dir: string;
  private readonly callbackUrl: string;
  /** Canonical form of `callbackUrl` for self-match comparison. */
  private readonly canonicalCallback: string;
  private readonly allowInsecureRemotes: boolean;
  /** Cached DCR result + tokens to avoid redundant disk reads within a flow. */
  private cachedClientInfo: OAuthClientInformationFull | null = null;
  private cachedTokens: OAuthTokens | null = null;
  /**
   * The deferred for the in-flight authorization. Set by `state()`, resolved
   * or rejected by `redirectToAuthorization` (for headless flows) or by the
   * HTTP callback route via the flow-registry (for interactive flows in a
   * future iteration).
   */
  private pendingFlow: Deferred<string> | null = null;

  constructor(opts: WorkspaceOAuthProviderOptions) {
    this.wsId = opts.wsId;
    this.serverName = opts.serverName;
    this.callbackUrl = opts.callbackUrl;
    this.canonicalCallback = canonicalEndpoint(new URL(opts.callbackUrl));
    this.allowInsecureRemotes = opts.allowInsecureRemotes === true;
    this.dir = join(
      opts.workDir,
      "workspaces",
      opts.wsId,
      "credentials",
      "mcp-oauth",
      opts.serverName,
    );
  }

  // ── OAuthClientProvider interface ─────────────────────────────────

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `NimbleBrain (${this.wsId})`,
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    const s = randomBytes(32).toString("base64url");
    // Create the deferred early so `awaitPendingFlow()` is safe to call any
    // time after `state()` runs. If an error unwinds before
    // `redirectToAuthorization`, we reject the deferred there to avoid
    // leaving consumers hanging.
    this.pendingFlow = deferred<string>();
    return s;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.cachedClientInfo) return this.cachedClientInfo;
    const data = await this.readJson<OAuthClientInformationFull>("client.json");
    if (data) this.cachedClientInfo = data;
    return data ?? undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    this.cachedClientInfo = info;
    await this.writeJson("client.json", info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.cachedTokens) return this.cachedTokens;
    const data = await this.readJson<OAuthTokens>("tokens.json");
    if (data) this.cachedTokens = data;
    return data ?? undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.cachedTokens = tokens;
    await this.writeJson("tokens.json", tokens);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.writeJson("verifier.json", { codeVerifier });
  }

  async codeVerifier(): Promise<string> {
    const data = await this.readJson<{ codeVerifier: string }>("verifier.json");
    if (!data) throw new Error("PKCE code verifier missing — OAuth flow corrupted");
    return data.codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.pendingFlow) {
      throw new Error(
        "[workspace-oauth-provider] redirectToAuthorization called without an active flow",
      );
    }
    const d = this.pendingFlow;

    // Follow the authorize redirect chain hop-by-hop. Headless providers
    // (Reboot `Anonymous`, client_credentials-style flows) eventually 302 to
    // our own callback with the authorization code already in the URL, at
    // which point we can extract it directly. Reboot specifically does two
    // hops: /__/oauth/authorize → /__/oauth/callback → our callback.
    //
    // We use manual redirect handling (not fetch's default follow) so we
    // can inspect every Location, stop as soon as one targets our callback,
    // and avoid actually dispatching a request to our own server (which
    // would tangle our own HTTP event loop into the probe).
    //
    // Real interactive providers (Granola, Claude.ai hosted) redirect to a
    // login page on a different origin — the loop never lands on our
    // callback and we fall through to the interactive branch.
    const MAX_HOPS = 10;
    let current = url;
    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        // SSRF defense: validate EVERY hop (including the initial URL the
        // server handed us), not just the configured bundle URL. The
        // authorize URL and every Location header are attacker-controlled —
        // a compromised remote MCP server could otherwise use our fetch()
        // as an internal-network probe tool (AWS IMDS, RFC1918 admin
        // panels, loopback services). Wrap with our marker prefix so the
        // outer catch rethrows instead of silently falling through to the
        // "interactive not supported" message.
        try {
          validateBundleUrl(current, { allowInsecure: this.allowInsecureRemotes });
        } catch (err) {
          throw new Error(
            `[workspace-oauth-provider] SSRF block on ${current.toString()}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        const res = await fetch(current.toString(), { redirect: "manual" });
        if (res.status < 300 || res.status >= 400) {
          // Non-redirect response — provider sent us a login page (200) or
          // an error (4xx/5xx). Not headless.
          break;
        }
        const location = res.headers.get("location");
        if (!location) break;
        const next = new URL(location, current);
        if (canonicalEndpoint(next) === this.canonicalCallback) {
          const code = next.searchParams.get("code");
          const errParam = next.searchParams.get("error");
          if (code) {
            log.debug(
              "mcp",
              `[oauth] headless flow: ${this.serverName} got code=${code.slice(0, 8)}… after ${hop + 1} hop(s)`,
            );
            d.resolve(code);
            return;
          }
          if (errParam) {
            const err = new Error(
              `[workspace-oauth-provider] authorization server returned error: ${errParam}`,
            );
            d.reject(err);
            throw err;
          }
          break;
        }
        current = next;
      }
    } catch (probeErr) {
      // Rethrow our own explicit errors (authz server error, SSRF block)
      // so callers see the real cause instead of the generic
      // "interactive not supported" message. Swallow network failures and
      // fall through to the interactive branch below.
      if (probeErr instanceof Error && probeErr.message.includes("[workspace-oauth-provider]")) {
        d.reject(probeErr);
        throw probeErr;
      }
      log.debug("mcp", `[oauth] ${this.serverName} redirect probe failed: ${String(probeErr)}`);
    }

    // Interactive flows (real browser redirect) are the extension point for
    // a future iteration — that's when the flow-registry becomes load-bearing
    // (the HTTP callback route resolves a registered flow by state). For now
    // we don't register: there's no one to wait for the code, and registering
    // would create an unhandled rejection when we immediately reject.
    const err = new InteractiveOAuthNotSupportedError(url.toString());
    // Reject the provider-local deferred so `awaitPendingFlow()` also fails
    // fast instead of hanging — consumers that await it get the same error
    // surface as the throw below.
    d.reject(err);
    throw err;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "client") {
      this.cachedClientInfo = null;
      await this.unlinkIfExists("client.json");
    }
    if (scope === "all" || scope === "tokens") {
      this.cachedTokens = null;
      await this.unlinkIfExists("tokens.json");
    }
    if (scope === "all" || scope === "verifier") {
      await this.unlinkIfExists("verifier.json");
    }
    // 'discovery' is SDK-internal metadata; we don't persist it.
  }

  // ── Extensions used by McpSource.start() ──────────────────────────

  /**
   * Await the in-flight authorization to yield an authorization code.
   * Called by `McpSource.start()` after catching `UnauthorizedError` so it
   * can then call `transport.finishAuth(code)` and retry `connect()`.
   *
   * Fails fast if the flow was rejected (e.g., interactive OAuth).
   */
  async awaitPendingFlow(): Promise<string> {
    if (!this.pendingFlow) {
      throw new Error(
        "[workspace-oauth-provider] awaitPendingFlow called with no active flow — " +
          "redirectToAuthorization was never invoked on this provider",
      );
    }
    return this.pendingFlow.promise;
  }

  // ── File I/O helpers ──────────────────────────────────────────────

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await chmod(this.dir, 0o700);
    } catch {
      // mkdir succeeded; chmod failure is non-fatal (file mode 0o600 still
      // protects the contents). A permissive parent leaks existence of
      // credentials via directory listings but not their values.
    }
  }

  private filePath(name: string): string {
    return join(this.dir, name);
  }

  private async readJson<T>(name: string): Promise<T | null> {
    const path = this.filePath(name);
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as T;
    } catch (err) {
      log.debug("mcp", `[oauth] failed to read ${path}: ${String(err)}`);
      return null;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await this.ensureDir();
    const path = this.filePath(name);
    const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
    const content = JSON.stringify(value, null, 2);
    await writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  private async unlinkIfExists(name: string): Promise<void> {
    const path = this.filePath(name);
    if (!existsSync(path)) return;
    try {
      await unlink(path);
    } catch {
      // ignore — file may have been removed concurrently
    }
  }
}
