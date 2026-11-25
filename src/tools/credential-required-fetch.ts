import type { FetchLike } from "@modelcontextprotocol/client";

/**
 * A transport fetch for an OAuth connection that never sends a request to the
 * MCP server without a credential: a request to the server's URL that carries
 * no `Authorization` header gets a 401 made for it, and the request is not
 * sent.
 *
 * A server may answer `server/discover`, `initialize` and `tools/list`
 * anonymously and require a token only on `tools/call`. The SDK starts sign-in
 * only on a 401, so without this such a connection reads as connected with no
 * token, and its first tool call fails after interactive sign-in is no longer
 * possible. The 401 here starts sign-in when the connection does instead:
 * `startAuth` gets an authorization URL, and a background start with no token
 * reads as `reauth_required`, the same as a server that answers 401 itself.
 *
 * The 401 carries no `WWW-Authenticate` header, so the SDK finds the protected
 * resource metadata at its path-aware well-known URL rather than at a URL this
 * fetch would have to invent. Every other request passes unchanged: discovery,
 * client registration, the token exchange and refresh go to other URLs, and a
 * request carrying a token (an expired one included) goes to the server, whose
 * own 401 drives the refresh.
 *
 * Outermost on the transport's fetch, so it reads the headers the SDK built.
 */
export function createCredentialRequiredFetch(inner: FetchLike, serverUrl: URL): FetchLike {
  const target = serverUrl.href;
  return async (input, init) => {
    if (
      new URL(input.toString()).href === target &&
      !new Headers(init?.headers).has("authorization")
    ) {
      return new Response(null, { status: 401, statusText: "Unauthorized" });
    }
    return inner(input, init);
  };
}
