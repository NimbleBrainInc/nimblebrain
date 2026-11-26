/**
 * The sign-in cookie names, read and written through this module only.
 *
 * Each name carries the `__Host-` prefix, so a browser accepts the cookie only
 * when this exact host sets it with `Secure`, `Path=/` and no `Domain`: no
 * other host, parent domain or sibling subdomain can set a sign-in cookie here.
 * Every sign-in cookie is therefore `Secure` and `Path=/` in every mode.
 * Every deployment serves the browser over HTTPS (a TLS-terminating edge), and
 * browsers treat `http://localhost` as a secure context, so no supported mode
 * needs an unprefixed or non-`Secure` name. The `dev` adapter sets no sign-in
 * cookies. A plain-HTTP address other than localhost cannot hold one.
 */

/** The access token: authenticates browser requests. */
export const SESSION_COOKIE = "__Host-nb_session";
/** The identity provider's refresh token: renews `SESSION_COOKIE`. */
export const REFRESH_COOKIE = "__Host-nb_refresh";
/** The in-progress sign-in (`<state>.<verifier>`), held by the browser that started it. */
export const LOGIN_COOKIE = "__Host-nb_login";

/** Attributes every sign-in cookie carries; `__Host-` requires all three. */
const HOST_ATTRIBUTES = ["HttpOnly", "SameSite=Lax", "Path=/", "Secure"] as const;

/** Build a sign-in `Set-Cookie` value. `maxAge` 0 clears the cookie. */
export function signInCookie(name: string, value: string, maxAge: number): string {
  return [`${name}=${value}`, ...HOST_ATTRIBUTES, `Max-Age=${maxAge}`].join("; ");
}

/** Read a cookie's value from the request's `Cookie` header, or null when absent. */
export function readSignInCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}
