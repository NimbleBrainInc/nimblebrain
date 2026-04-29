import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { validateBundleUrl } from "../bundles/url-validator.ts";
import { log } from "../cli/log.ts";
import { register as registerInteractiveFlow } from "./oauth-flow-registry.ts";

/**
 * Sentinel kept for callers that import the symbol. The original
 * fast-fail behavior is gone — interactive OAuth is now supported by
 * registering with the flow registry and awaiting via the
 * `onInteractiveAuthRequired` callback. Any code that still throws this
 * is a regression.
 *
 * @deprecated Interactive OAuth is supported. The provider now throws
 * the SDK's own `UnauthorizedError` after registering the flow, which
 * `McpSource.start()` catches and retries via `awaitPendingFlow`.
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
  /**
   * Fired once the provider has determined the OAuth flow requires a real
   * browser (the headless redirect probe didn't land on our callback).
   *
   * The provider invokes this callback synchronously *before* throwing
   * `UnauthorizedError`, with the authorization URL the caller's browser
   * should be sent to. The receiver typically:
   *
   *   1. Transitions its Connection to `pending_auth`
   *   2. Stores the URL so `/v1/mcp-auth/initiate` can find it
   *   3. Emits a `connection.state_changed` SSE event for the UI banner
   *
   * The flow is also already registered with `oauth-flow-registry` by the
   * time this callback fires, so a `state` value is bound to the
   * `(wsId, serverName)` pair and ready to be resolved by the callback
   * route.
   *
   * Errors thrown from this callback are swallowed (the provider must
   * still throw `UnauthorizedError` to escape the SDK auth flow). Keep
   * the implementation cheap and defensive.
   */
  onInteractiveAuthRequired?: (authorizationUrl: string) => void;
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
  private readonly onInteractiveAuthRequired?: (authorizationUrl: string) => void;
  /** Cached DCR result + tokens to avoid redundant disk reads within a flow. */
  private cachedClientInfo: OAuthClientInformationFull | null = null;
  private cachedTokens: OAuthTokens | null = null;
  /**
   * The promise for the in-flight authorization. Set by `state()` to a
   * provider-local deferred (used by headless flows that resolve in
   * `redirectToAuthorization`). On the interactive branch, it's REPLACED
   * with the `oauth-flow-registry` promise — that one resolves when the
   * HTTP callback route receives the code from the user's browser.
   *
   * `awaitPendingFlow()` reads `.promise` so it works for both branches
   * uniformly.
   */
  private pendingFlow: { promise: Promise<string>; deferred?: Deferred<string> } | null = null;
  /**
   * The latest state value generated by `state()`. Captured so the
   * interactive branch of `redirectToAuthorization` can register the
   * correct flow with `oauth-flow-registry` even if the SDK adds extra
   * state munging between `state()` and the URL build.
   */
  private currentState: string | null = null;

  constructor(opts: WorkspaceOAuthProviderOptions) {
    this.wsId = opts.wsId;
    this.serverName = opts.serverName;
    this.callbackUrl = opts.callbackUrl;
    this.canonicalCallback = canonicalEndpoint(new URL(opts.callbackUrl));
    this.allowInsecureRemotes = opts.allowInsecureRemotes === true;
    this.onInteractiveAuthRequired = opts.onInteractiveAuthRequired;
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
    // time after `state()` runs. The headless branch resolves this in
    // `redirectToAuthorization`. The interactive branch replaces the
    // promise with the flow-registry's promise so the HTTP callback route
    // is the resolver.
    const d = deferred<string>();
    this.pendingFlow = { promise: d.promise, deferred: d };
    this.currentState = s;
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
    // Local deferred for the headless branch. The interactive branch
    // doesn't use this — it swaps `pendingFlow.promise` for the flow
    // registry's promise instead.
    const d = this.pendingFlow.deferred;

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
        // interactive branch.
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
            d?.resolve(code);
            return;
          }
          if (errParam) {
            const err = new Error(
              `[workspace-oauth-provider] authorization server returned error: ${errParam}`,
            );
            d?.reject(err);
            throw err;
          }
          break;
        }
        current = next;
      }
    } catch (probeErr) {
      // Rethrow our own explicit errors (authz server error, SSRF block)
      // so callers see the real cause instead of the generic
      // interactive-branch surface. Swallow network failures and fall
      // through to the interactive branch below.
      if (probeErr instanceof Error && probeErr.message.includes("[workspace-oauth-provider]")) {
        d?.reject(probeErr);
        throw probeErr;
      }
      log.debug("mcp", `[oauth] ${this.serverName} redirect probe failed: ${String(probeErr)}`);
    }

    // Interactive branch: real browser redirect required. Register the
    // flow with `oauth-flow-registry` so the HTTP callback route can
    // resolve it once the user completes the authorization. Replace the
    // provider-local promise with the registry's promise so
    // `awaitPendingFlow()` returns the registry-resolved code.
    //
    // Extract `state` from the authorize URL the SDK built. The SDK
    // takes our `state()` value and embeds it as `?state=...`; pulling
    // from the URL keeps us robust if the SDK ever munges the value
    // (e.g., wraps it for its own bookkeeping).
    const stateParam = url.searchParams.get("state") ?? this.currentState;
    if (!stateParam) {
      const err = new Error(
        "[workspace-oauth-provider] interactive flow requested but no state parameter in authorize URL",
      );
      d?.reject(err);
      throw err;
    }

    log.debug(
      "mcp",
      `[oauth] interactive flow: ${this.serverName} registering state=${stateParam.slice(0, 8)}… url=${url.origin}…`,
    );

    const registryPromise = registerInteractiveFlow(stateParam, this.wsId, this.serverName);
    this.pendingFlow = { promise: registryPromise };

    // Notify the lifecycle / UI so the bundle transitions to pending_auth
    // and the banner appears. Errors from the callback must not break the
    // OAuth dance — log and continue. The registry registration above is
    // already in place, so the callback handler can resolve the flow even
    // if the lifecycle notification path is broken.
    if (this.onInteractiveAuthRequired) {
      try {
        this.onInteractiveAuthRequired(url.toString());
      } catch (cbErr) {
        log.warn(
          `[oauth] onInteractiveAuthRequired callback threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
        );
      }
    }

    // Throw the SDK's own UnauthorizedError so `Client.connect()` aborts
    // cleanly — `McpSource.start()` catches this and awaits
    // `awaitPendingFlow()`, which now returns the registry promise.
    throw new UnauthorizedError(
      `Interactive OAuth required for ${this.serverName} — pending user authorization at ${url.origin}.`,
    );
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
