/**
 * URL safety helpers shared across the connector / registry boundaries.
 *
 * The connector wire format (`ServerDetail`) carries several URL-typed
 * fields — icon `src`, `repository.url`, `websiteUrl`, the
 * `_meta["ai.nimblebrain/connector"].operatorSetup.portalUrl` and
 * `docsUrl` extensions, and `remotes[].url`. Upstream ajv only checks
 * `format: "uri"`, which accepts `javascript:` / `data:` / `file:`
 * schemes. Whenever we render or follow these URLs in the UI, we
 * narrow the allowed schemes to http(s) so a malicious or
 * misconfigured catalog entry can't smuggle a script-execution vector
 * past the schema.
 */

/**
 * Returns true when `value` parses as an absolute URL with the
 * `http:` or `https:` scheme. Anything else (`javascript:`, `data:`,
 * `file:`, malformed, empty) returns false.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
