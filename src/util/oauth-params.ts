/**
 * Pure validation for operator-supplied `additionalAuthorizationParams`.
 *
 * Kept free of the `WorkspaceOAuthProvider` module's dependency surface
 * (MCP SDK auth, the OAuth flow registry, `validateBundleUrl`, crypto/fs)
 * so the registry / config-load layers can run the reserved-key check
 * without dragging the full provider in. Same rationale as `url.ts` —
 * pure helpers live in `src/util/`.
 */

/**
 * Reserved authorize-URL params that the OAuth flow controls itself.
 * Operator-supplied `additionalAuthorizationParams` from
 * `workspace.json` MUST NOT include these — overriding any of them
 * would let a misconfigured catalog entry break PKCE binding or steal
 * the redirect target. Validated at config load (see
 * `validateAdditionalAuthorizationParams`).
 */
export const RESERVED_AUTHORIZE_PARAMS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  // OIDC-style hijack vectors: `request` / `request_uri` smuggle a
  // signed/unsigned JWT request object that can override every other
  // parameter; `response_mode` can change response delivery (form_post,
  // fragment) in ways that break our callback assumptions.
  "request",
  "request_uri",
  "response_mode",
] as const;

/**
 * Throw if any reserved key appears in the params map. Called at the
 * boundary where `workspace.json` is parsed — bundle install /
 * `seedInstance` — so a bad config fails loud rather than at OAuth-
 * flow time.
 */
export function validateAdditionalAuthorizationParams(
  params: Record<string, string> | undefined,
): void {
  if (!params) return;
  const reserved = RESERVED_AUTHORIZE_PARAMS.filter((k) => k in params);
  if (reserved.length > 0) {
    throw new Error(
      `[oauth-params] additionalAuthorizationParams cannot include reserved keys: ${reserved.join(", ")}`,
    );
  }
}
