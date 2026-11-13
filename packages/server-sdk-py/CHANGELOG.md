# Changelog

## [Unreleased]

### Added

- `[outbox]` (`nimblebrain_server_sdk.outbox`): the server half of the notification protocol.
  An outbox table under `[db]`'s row-level security, `emit` inside the caller's transaction,
  the poll the host reads it with, and its metrics. See the README's
  [Notifications](README.md#notifications-outbox).

## [0.5.0]

### Changed

- `[db]` requires `pgbulkhead` 0.1.2 (pinned exactly) and SQLAlchemy 2.0.44 or later. The
  rendered SQL and the statements each session sends are unchanged.
- **`[db]` pooled engines refuse a role that row-level security does not apply to.**
  `create_pooled_engine` and `SecuredDatabase` refuse each new connection made as a superuser
  or `BYPASSRLS` role with `UnsafeRoleError`, before any session runs on it. A server that
  connects as such a role fails instead of silently seeing every tenant's rows. An engine meant
  to bypass, such as one your migrations or provisioning run on, opts out with
  `refuse_bypass_roles=False` on either.

### Added

- `[db]`: `UnsafeRoleError` (pgbulkhead's own class), and `SecuredDatabase.check_role()` to fail
  the rollout at startup rather than the first call.
- `[db]`: the `refuse_bypass_roles` keyword (default `True`) on `create_pooled_engine` and
  `SecuredDatabase`.

## [0.4.1]

### Fixed

- `[observability]`: `ObservabilityMiddleware` reads a `traceparent`, `x-correlation-id`,
  identity or caller header whose value is not UTF-8 as absent, instead of failing the
  request with a 500 that RED metrics never counted.

## [0.4.0]

### Highlights

- **Errors in the core:** `nimblebrain_server_sdk.errors` carries the service error contract
  every NimbleBrain server reports failures with.
- **Two optional extras:** `[db]` for tenant- and workspace-isolated Postgres access, and
  `[observability]` for metrics, JSON logs and traces. The core imports neither.

### Breaking

- **Requires Python 3.13 or later** (was 3.11), for the core and both extras.

### Added

- `nimblebrain_server_sdk.errors`: `ServiceError`, `ErrorCode`, `ServiceError.from_upstream`,
  `to_tool_error`, `rate_limited_tool_error` and `CapacityRefusal`, beside
  `HostCapabilityMissing`. See the README's [Errors](README.md#errors).
- `[db]` (`nimblebrain_server_sdk.db`): row-level security policies, RLS-bound sessions,
  edge-header identity, a sized pool and per-workspace admission, on `pgbulkhead` 0.1.1.
- `[observability]` (`nimblebrain_server_sdk.observability`): `instrument_app`, the metric
  factories, structured logging and trace propagation. With it installed, every surfaced
  error also counts in `service_errors_total`.
- Importing `db` or `observability` without its extra raises an `ImportError` naming the extra.

## [0.3.1]

### Fixed

- **Host resources on 2026-07-28:** `available` and `list_available` are `False` and `read`/`list`
  raise `HostCapabilityMissing` on a 2026-07-28 connection, which has no channel for the host
  request; `read` used to fail on the wire there.
- **Typed package:** the wheel ships `py.typed`, so type checkers read the SDK's annotations.
- **Docs** name `mcp.shared.exceptions.MCPError`, the class `mcp` 2 raises.

### Changed

- `__version__` comes from the installed distribution.
- Supports Python 3.14.

## [0.3.0]

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

- **Requires `fastmcp>=4.0.0`** with no upper bound, `mcp>=2.0.0,<2.4.0` (was `<2.3.0`), and
  `pydantic>=2.12`.
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
