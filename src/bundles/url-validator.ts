// ---------------------------------------------------------------------------
// URL validation for remote bundle connections — SSRF protection.
// Rejects private IPs, cloud metadata endpoints, non-HTTPS, and
// embedded credentials before any network connection is made.
// ---------------------------------------------------------------------------

/** Hostnames known to serve cloud provider instance metadata. */
const METADATA_HOSTNAMES = ["metadata.google.internal", "metadata.goog", "instance-data"];

/**
 * IPv4 private/reserved range patterns (RFC 1918 + link-local + loopback).
 * Checked against the URL hostname string — no DNS resolution is performed
 * (intentionally avoids DNS rebinding bypass).
 */
const PRIVATE_IPV4_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^169\.254\./, // link-local / cloud metadata
  /^0\./, // 0.0.0.0/8
];

/** IPv6 loopback and unique-local patterns. */
const PRIVATE_IPV6_PATTERNS = [
  /^::1$/, // loopback
  /^\[::1\]$/, // bracketed loopback
  /^fc/, // fc00::/7 unique-local
  /^fd/, // fc00::/7 unique-local
  /^\[fc/, // bracketed
  /^\[fd/, // bracketed
];

/** Strip square brackets from IPv6 hostnames for pattern matching. */
function bareHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/** Match IPv4-mapped IPv6 addresses in dotted form (::ffff:127.0.0.1) */
const IPV4_MAPPED_DOTTED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** Match IPv4-mapped IPv6 addresses in hex form (::ffff:7f00:1) — as normalized by URL constructor */
const IPV4_MAPPED_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address.
 * Handles both dotted form (::ffff:127.0.0.1) and hex form (::ffff:7f00:1).
 * Returns the IPv4 string or null if not a mapped address.
 */
function extractMappedIpv4(bare: string): string | null {
  // Dotted form: ::ffff:127.0.0.1
  const dottedMatch = bare.match(IPV4_MAPPED_DOTTED_RE);
  if (dottedMatch) return dottedMatch[1]!;

  // Hex form: ::ffff:7f00:1 (URL constructor normalizes to this)
  const hexMatch = bare.match(IPV4_MAPPED_HEX_RE);
  if (hexMatch) {
    const hi = Number.parseInt(hexMatch[1]!, 16);
    const lo = Number.parseInt(hexMatch[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

function isPrivateHostname(hostname: string): boolean {
  const bare = bareHostname(hostname).toLowerCase();

  // Cloud metadata hostnames
  if (METADATA_HOSTNAMES.includes(bare)) return true;

  // IPv4-mapped IPv6 addresses — extract embedded IPv4 and check against private ranges
  const embeddedIpv4 = extractMappedIpv4(bare);
  if (embeddedIpv4) {
    for (const pattern of PRIVATE_IPV4_PATTERNS) {
      if (pattern.test(embeddedIpv4)) return true;
    }
    return false; // Public IPv4 embedded in mapped form
  }

  // IPv4 private ranges
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(bare)) return true;
  }

  // IPv6 private ranges
  for (const pattern of PRIVATE_IPV6_PATTERNS) {
    if (pattern.test(bare)) return true;
  }

  return false;
}

function isLocalhostHostname(hostname: string): boolean {
  const bare = bareHostname(hostname).toLowerCase();
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "[::1]") {
    return true;
  }
  // IPv4-mapped IPv6 loopback (dotted or hex form)
  const mapped = extractMappedIpv4(bare);
  return mapped !== null && mapped.startsWith("127.");
}

/**
 * Validate a URL for use as a remote bundle endpoint.
 *
 * Throws on:
 * - Non-HTTPS protocol (exception: http://localhost and http://127.0.0.1
 *   when `allowInsecure` is true)
 * - Hostname is a private/reserved IP range
 * - Cloud metadata hostnames (metadata.google.internal, instance-data)
 * - Embedded credentials (url.username or url.password non-empty)
 */
export function validateBundleUrl(url: URL, opts?: { allowInsecure?: boolean }): void {
  const allowInsecure = opts?.allowInsecure ?? false;

  // Reject embedded credentials
  if (url.username || url.password) {
    throw new Error(`Remote bundle URL must not contain embedded credentials: ${url.toString()}`);
  }

  // Reject private/reserved hostnames (always, even with allowInsecure)
  if (isPrivateHostname(url.hostname) && !isLocalhostHostname(url.hostname)) {
    throw new Error(`Remote bundle URL resolves to a private/reserved address: ${url.hostname}`);
  }

  // Protocol check
  if (url.protocol === "https:") {
    return; // HTTPS is always allowed
  }

  if (url.protocol === "http:") {
    if (allowInsecure && isLocalhostHostname(url.hostname)) {
      return; // HTTP localhost allowed in dev mode
    }
    throw new Error(
      `Remote bundle URL must use HTTPS (got ${url.protocol}//${url.hostname}). ` +
        (isLocalhostHostname(url.hostname)
          ? 'Set "allowInsecureRemotes": true in nimblebrain.json for local development.'
          : "Non-HTTPS remote connections are not permitted."),
    );
  }

  // Reject any other protocol
  throw new Error(`Remote bundle URL uses unsupported protocol: ${url.protocol}`);
}
