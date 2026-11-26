# Changelog

## [0.9.1]

### Fixed

- `host(ctx).read` and `.list` send their request on the stream of the tool call they serve. The host answers host-resources requests only there, for the user that call was made for, and refuses one on the connection's standalone stream with `-32003`. See [Host Resources](https://docs.nimblebrain.ai/extensions/host-resources/).

## [0.9.0]

### Changed

- A Server Card's host block carries `hostVersion`, the camelCase key the host reads. See [Server Card](https://docs.nimblebrain.ai/server-sdk/server-card/).

### Deprecated

- `Placement.size`: the shell never read it, and the host schema no longer has it. A placement that sets it gets a `DeprecationWarning`, and the card leaves it out. It is removed in 0.10.

## [0.8.1]

### Changed

- `add_server_card(title=...)` also reports the title as the server's `serverInfo.title`: in the `initialize` result, and in the `serverInfo` stamp of the 2026-07-28 `server/discover` result. A client that reads only the handshake shows the title instead of the reverse-DNS name. A title the server already reports there through its own middleware is kept.

## [0.8.0]

### Added

- `add_server_card` serves the server's MCP Server Card (SEP-2127) at `<mcp-path>/server-card`, built from its name, version, website and icons plus a declared title, description and `ai.nimblebrain/host` placements; a local NimbleBrain reads it when the server is added by URL. See [Server Card](https://docs.nimblebrain.ai/server-sdk/server-card/).
- `Placement`, `HOST_META_KEY`, `SERVER_CARD_MEDIA_TYPE` and `SERVER_CARD_SCHEMA`.

## [0.7.2]

### Fixed

- A logged exception that is, or was caused by, a database error no longer carries row data. Its traceback keeps every frame and class with each message withheld, since Postgres's `DETAIL` and SQLAlchemy's `[parameters: ...]` both carry the row's values. The line adds `db_error`: SQLSTATE, constraint, table, column and schema. `[observability]` still needs no database package.
- An exported span records a database error, inside an exception group too, with its type only: no message, no stacktrace (a message line can imitate a frame), and no `str(exc)` in its status. The frames are on the log line.
- `[db]`: `SecuredDatabase` builds its engine with `hide_parameters=True`, so a database error's text names the statement but never its bound values.

## [0.7.1]

### Fixed

- `new_prefixed_id` accepts a prefix of several segments joined by single underscores (`po_cmp`), which 0.7.0 refused. A ULID has no underscore, so the last underscore of an id still separates prefix from body. A server whose prefixes carry one can move off 0.6.1.
- With `add_error_contract`, FastMCP no longer logs an error-level traceback for a `ServiceError` or capacity refusal raised in a tool call on that server. The error is recorded once, as `service_error`, at its own level. FastMCP's record is kept for a resource read, a prompt, and a server without the contract.

## [0.7.0]

### Highlights

- A `[db]` migration runs on asyncpg: `rls_policy_statements` returns the policy one statement per item.
- A server's tests reach its tools with a verified identity through `db.testing.edge_client`.
- `add_error_contract(mcp)` returns the error contract for a `ServiceError` or capacity refusal a tool raises.
- The README is a complete server and its test; the guides and API reference are at [docs.nimblebrain.ai/server-sdk](https://docs.nimblebrain.ai/server-sdk/quickstart/).

### Breaking

- `[db]`: `AuthError` is a `ServiceError` (`auth_required`). `str(exc)` is now text safe to show a caller; the missing header is in `exc.detail`. It no longer names the edge deployment.
- `new_prefixed_id` raises `ValueError` for a prefix that is not lowercase ASCII letters and digits.

### Added

- `[db]`: `rls_policy_statements`, `rls_policy_statements_tenant_scoped` and `rls_policy_statements_org_scoped`.
- `[db]`: `nimblebrain_server_sdk.db.testing.edge_client`, for tests only: it sends the identity headers as the edge does and changes nothing in the server.
- `add_error_contract` and `ErrorContractMiddleware`.
- `HostCapabilityMissing.protocol_version`; on a 2026-07-28 connection the message names the protocol era as the cause.
- `testing.Mode` (`Literal["auto", "legacy"]`), the type of every helper's `mode`, and `testing.__all__`.

### Changed

- A `bad_input` error is logged at `WARNING`, not `ERROR`; it is still counted in `service_errors_total`.
- The missing-extra `ImportError` suggests `uv add` as well as `pip install`.
- Project metadata: a one-line description, and Documentation, Changelog and Source URLs.

## [0.6.1]

### Changed

- **`[db]` refuses sessions that bypass row-level security, not only roles whose
  attributes say so.** `[db]` requires `pgbulkhead` 0.1.3 (pinned exactly), whose guard also
  refuses a member of a managed Postgres admin role (on Amazon RDS, `rds_superuser`, which
  bypasses with neither `SUPERUSER` nor `BYPASSRLS`) and any session a rolled-back probe sees
  bypass a forced policy. The probe needs the `TEMP` privilege and a writable session; without
  either, only the attribute and membership checks run and pgbulkhead logs a warning. The
  rendered SQL and the statements each session sends are unchanged.

### Added

- `[db]`: `MANAGED_ADMIN_ROLES`, the admin roles the guard refuses membership in.

## [0.6.0]

### Added

- `[outbox]` (`nimblebrain_server_sdk.outbox`): the server half of the notification protocol.
  An outbox table under `[db]`'s row-level security, `emit` inside the caller's transaction,
  the poll the host reads it with, and its metrics. See the README's
  [Notifications](README.md#notifications-outbox).
  `emit` refuses any envelope the host's parser would drop (whitespace in a name, a `null`
  presentation field, a length over a limit in UTF-16 code units, or a size over 64 KiB as the
  host measures it), so an accepted notification is never lost at the host.

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
