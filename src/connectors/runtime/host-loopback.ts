/**
 * The local-install gate (ADR-0065): how a runtime inside a container reaches
 * an MCP server the developer runs on the host.
 *
 * On a local install, `127.0.0.1` inside the container is the container, not
 * the developer's machine. The release Compose file maps a name that reaches
 * the host (`host.docker.internal`) and sets `NB_HOST_LOOPBACK` to it. When the
 * instance also runs the `dev` identity provider, which only a local install
 * writes, the runtime:
 *
 *   - admits plain `http` to loopback names (`allowInsecureRemotes`, which
 *     admits exactly `localhost`, `127.0.0.1` and `::1` and nothing else), and
 *   - dials a stored loopback URL at the alias instead, keeping the original
 *     `Host` header (`loopbackDial`). The stored URL stays as the developer
 *     typed it, so the same row works under `bun run dev`, where no alias is set.
 *
 * Everywhere else the variable is ignored: a deployed instance never uses the
 * `dev` adapter, so setting the variable there changes nothing.
 */

import type { AuthConfig } from "../../identity/instance.ts";

/**
 * The host alias to dial loopback URLs through, or null when the gate is shut.
 * Open only when `envValue` is a bare hostname (no scheme, port or path) and
 * the instance's auth adapter is `dev`.
 */
export function resolveHostLoopback(
  envValue: string | undefined,
  adapter: AuthConfig["adapter"] | undefined,
): string | null {
  if (adapter !== "dev") return null;
  return parseHostAlias(envValue);
}

/** `value` as a bare hostname, lowercased, or null when it is empty or carries more than a host. */
export function parseHostAlias(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    return null;
  }
  const bare = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (bare !== trimmed.toLowerCase().replace(/^\[(.*)\]$/, "$1")) return null;
  return bare;
}

let dialAlias: string | null = null;

/** Set the process's dial alias. Called once, by `Runtime.start`. */
export function setHostLoopbackAlias(alias: string | null): void {
  dialAlias = alias;
}

/** The process's dial alias, or null when loopback URLs are dialed as stored. */
export function hostLoopbackAlias(): string | null {
  return dialAlias;
}

/** Clear the dial alias between tests. */
export function _resetHostLoopbackForTest(): void {
  dialAlias = null;
}

/** Whether `hostname` (as `URL.hostname` reports it) names this machine's loopback. */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

/**
 * Where to send a request for `url`: the same URL with its hostname replaced by
 * the alias (port, path and query kept) and the `Host` header set to the
 * original `host:port`, when an alias is set and `url` names a loopback host.
 * Otherwise `url` and `init` unchanged.
 *
 * Call it at the network dial, after the URL is validated, so validation and
 * redirect handling always see the stored URL.
 */
export function loopbackDial(
  url: URL,
  init: RequestInit | undefined,
  alias: string | null = dialAlias,
): { url: URL; init: RequestInit | undefined } {
  if (alias === null || !isLoopbackHostname(url.hostname)) return { url, init };
  const dialed = new URL(url.toString());
  dialed.hostname = alias.includes(":") ? `[${alias}]` : alias;
  const headers = new Headers(init?.headers);
  headers.set("host", url.host);
  return { url: dialed, init: { ...init, headers } };
}
