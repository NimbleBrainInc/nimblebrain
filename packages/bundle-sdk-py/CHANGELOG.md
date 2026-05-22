# Changelog

## [Unreleased]

## [0.1.0]

Initial release. Wraps the `ai.nimblebrain/host-resources` MCP extension
(Phase 1 + Phase 2a in the NimbleBrain platform).

### Added

- `host(ctx)` factory + `HostResources` class.
- `HostResources.available` capability probe — reads
  `ClientCapabilities.extensions["ai.nimblebrain/host-resources"]`
  with a fallback to the legacy `experimental` slot for older platforms.
- `HostResources.supports_scheme(scheme)` per-scheme check against the
  host's advertised allowlist.
- `HostResources.read(uri)` — wraps `ai.nimblebrain/resources/read`,
  returns the MCP-standard `ReadResourceResult`.
- `HostResources.list(mime_type=..., tags=...)` — wraps
  `ai.nimblebrain/resources/list` with the platform's `_meta.filter`
  unwrap convention. Returns `ListResourcesResult`.
- `HostCapabilityMissing` exception for the "host doesn't advertise the
  extension" case — supports the Level-C fallback pattern (catch + return
  a structured tool error that teaches the agent to retry).
- Error-code constants (`RATE_LIMITED = -32004`, `RESPONSE_TOO_LARGE =
  -32005`) so bundle authors don't hard-code magic numbers when matching
  on `McpError.error.code`.

### Requirements

- Python 3.11+
- `fastmcp>=3.0.0`
- `mcp>=1.27.0`
