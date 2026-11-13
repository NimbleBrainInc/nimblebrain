# Changelog

## [Unreleased]

### Highlights

- **Published as `nimblebrain-server-sdk`** (import `nimblebrain_server_sdk`): the SDK for any
  MCP server that runs on NimbleBrain, app or connector. `nimblebrain-bundle-sdk` stays at
  0.2.0 and gets no further releases.
- **Server helpers:** tool annotations, change announcements, the `ai.nimblebrain/facets`,
  `lifecycle` and `view` extensions, bounded listing rows, record ids, and `testing` checks
  that read a server the way a host does.

### Breaking

- **Import path** is `nimblebrain_server_sdk`; every 0.2.0 name is exported unchanged there.
- **Install name** is `nimblebrain-server-sdk`.

### Added

- `READS`, `ADDS`, `CHANGES` tool annotations.
- `announce_resource_list_changed`: a committed write tells the host its views should re-read.
- `add_platform_extension` / `PlatformExtension`, and the facets (`facet_meta`,
  `facet_count`), lifecycle (`add_lifecycle_extension`) and record-view (`record_view_meta`)
  extensions.
- `add_skills(mcp, skills)`: registers `SkillsExtension` on a FastMCP server in one call.
- `listing_row`, `preview_text`, `PREVIEW_CHARS`; `new_ulid`, `new_prefixed_id`.
- `nimblebrain_server_sdk.testing`: `served_skills`, `served_facets`, `assert_bounded_rows`.

### Changed

- **Requires `fastmcp>=4.0.0`** with no upper bound, and `pydantic>=2.12`.
- **Licensed under Apache-2.0**, the license of the repository it ships from. Releases up to
  and including 0.2.0 remain available under MIT.

## [0.2.0]

### Added

- **Skills extension (SEP-2640).** `SkillsExtension` (FastMCP, `mcp.add_extension`) and
  `MCPServerSkillsExtension` (`mcp` SDK `MCPServer(extensions=[...])`) declare
  `io.modelcontextprotocol/skills`, answer `skills/list` and `skills/get`, and serve every
  skill file through `resources/read`. Skills come from directories or from in-memory
  `SkillDefinition`s; digests, sizes, and the name-equals-last-URI-segment rule are
  checked at construction. See the README's Skills section.

### Changed

- **Requires `mcp>=2.0.0,<2.3.0` and `fastmcp>=4.0.0,<5`** (was
  `mcp>=1.27.0,<2.0.0` / `fastmcp>=3.0.0`). The two majors are coupled:
  `fastmcp-slim` 4 requires `mcp>=2` and `fastmcp-slim` 3 requires
  `mcp<2`, so there is no build of this SDK that spans both. Bundles
  still on FastMCP 3 must upgrade before taking this version.
- Requires `pyyaml>=6.0`, for `SKILL.md` frontmatter.
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
