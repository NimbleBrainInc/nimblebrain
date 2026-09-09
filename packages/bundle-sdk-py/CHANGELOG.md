# Changelog

## [Unreleased]

### Changed

- **Requires `mcp>=2.1.1,<2.2.0` and `fastmcp>=4.0.0,<5`** (was
  `mcp>=1.27.0,<2.0.0` / `fastmcp>=3.0.0`). The two majors are coupled:
  `fastmcp-slim` 4 requires `mcp>=2` and `fastmcp-slim` 3 requires
  `mcp<2`, so there is no build of this SDK that spans both. Bundles
  still on FastMCP 3 must upgrade before taking this version.
- Capability detection reads `ClientCapabilities.extensions` as the
  declared field it became in `mcp` 2. It was previously read out of
  `model_extra`, which `mcp` 2 no longer populates — left unchanged,
  a host advertising in the spec-blessed `extensions` slot would have
  read as unavailable and every `read()`/`list()` would have raised
  `HostCapabilityMissing`. The legacy `experimental` fallback is
  unchanged.

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
