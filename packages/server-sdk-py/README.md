# nimblebrain-server-sdk

The Python SDK for building MCP servers that run on NimbleBrain.

It covers what a server shares with the NimbleBrain host it runs in. The MCP protocol itself
comes from the `mcp` package, through [FastMCP](https://gofastmcp.com). Full documentation:
**[docs.nimblebrain.ai/server-sdk](https://docs.nimblebrain.ai/server-sdk/quickstart/)**.

## Which package

A server alone is a connector. A server plus its interface is an app.

| Package | Registry | What it is for |
| --- | --- | --- |
| `nimblebrain-server-sdk` (this package) | [PyPI](https://pypi.org/project/nimblebrain-server-sdk/) | The server: tool annotations, change announcements, the `ai.nimblebrain` extensions, skills, the error contract, and, as extras, database access, observability and notifications |
| `@nimblebrain/synapse` | [npm](https://www.npmjs.com/package/@nimblebrain/synapse) | An app's interface: the part that runs in the browser |
| `@nimblebrain/sdk` | [npm](https://www.npmjs.com/package/@nimblebrain/sdk) | The API client: a program that calls NimbleBrain's API |

A connector needs only this package. An app also has an interface, built with
`@nimblebrain/synapse`, which the server serves as a `ui://` resource with FastMCP's
`fastmcp.apps.AppConfig`: see
[Serve a Synapse UI from a FastMCP server](https://synapse.nimblebrain.ai/docs/quickstart-python/)
and [ChatGPT compatibility](https://synapse.nimblebrain.ai/docs/guides/chatgpt/).

## Install

```bash
uv add nimblebrain-server-sdk
# or
pip install nimblebrain-server-sdk
```

Requires Python 3.13 or later.

## A complete server

`notes.py`: two tools, a count the host shows beside the server's name, and errors a host can
act on.

<!-- example: examples/notes.py -->
```python
"""A complete connector: two tools, a count the host shows, and the error contract."""

from fastmcp import Context, FastMCP

from nimblebrain_server_sdk import (
    ADDS,
    FACETS_EXTENSION_ID,
    READS,
    add_error_contract,
    add_platform_extension,
    announce_resource_list_changed,
    facet_count,
    facet_meta,
    new_prefixed_id,
)
from nimblebrain_server_sdk.errors import ErrorCode, ServiceError

mcp = FastMCP("notes")
add_error_contract(mcp)  # a ServiceError a tool raises reaches the caller with its code
add_platform_extension(mcp, FACETS_EXTENSION_ID)

NOTES: dict[str, str] = {}


@mcp.tool(annotations=ADDS)
async def save_note(text: str, ctx: Context) -> dict[str, str]:
    """Save a note and return its id."""
    if not text.strip():
        raise ServiceError(ErrorCode.BAD_INPUT, "`text` is empty.")
    note_id = new_prefixed_id("nt")
    NOTES[note_id] = text
    await announce_resource_list_changed(ctx)  # after the write, so open views re-read
    return {"id": note_id}


@mcp.tool(annotations=READS)
async def get_note(note_id: str) -> dict[str, str]:
    """Read one note by id."""
    if note_id not in NOTES:
        raise ServiceError(ErrorCode.NOT_FOUND, "No note has that id.")
    return {"id": note_id, "text": NOTES[note_id]}


@mcp.resource(
    "notes://facets/total",
    name="notes-total",
    title="Notes",
    mime_type="application/json",
    meta=facet_meta("info"),
)
async def notes_total() -> str:
    return facet_count(len(NOTES))


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8000)
```

Run it, then connect any MCP client to `http://127.0.0.1:8000/mcp`:

```bash
uv run python notes.py
```

To add it to NimbleBrain, see
[connect it to NimbleBrain](https://docs.nimblebrain.ai/server-sdk/quickstart/#connect-it-to-nimblebrain).

### Test it

`test_notes.py` checks the server the way a host reads it. `fastmcp.Client(mcp, mode=...)`
chooses the protocol era: `"auto"` negotiates 2026-07-28 and `"legacy"` runs the 2025-11-25
`initialize` handshake. A host may connect on either, so test both.

<!-- example: examples/test_notes.py -->
```python
"""The notes server, checked the way a host reads it, on both protocol eras."""

import pytest
from fastmcp import Client
from notes import NOTES, mcp

from nimblebrain_server_sdk.testing import Mode, served_facets


@pytest.fixture(autouse=True)
def empty_store() -> None:
    NOTES.clear()


@pytest.mark.parametrize("mode", ["auto", "legacy"])  # 2026-07-28, then 2025-11-25
async def test_a_saved_note_reads_back_and_is_counted(mode: Mode) -> None:
    async with Client(mcp, mode=mode) as client:
        saved = await client.call_tool("save_note", {"text": "hello"})
        note = await client.call_tool("get_note", {"note_id": saved.data["id"]})
    assert note.data == {"id": saved.data["id"], "text": "hello"}
    assert await served_facets(mcp, mode) == {
        "notes-total": {"title": "Notes", "level": "info", "count": 1}
    }


async def test_a_missing_note_is_a_not_found_error() -> None:
    async with Client(mcp) as client:
        result = await client.call_tool("get_note", {"note_id": "nt_0"}, raise_on_error=False)
    assert result.is_error
    assert result.structured_content == {
        "error": {"code": "not_found", "retryable": False, "message": "No note has that id."}
    }
```

```bash
uv add --dev pytest pytest-asyncio   # with asyncio_mode = "auto" under [tool.pytest.ini_options]
uv run pytest
```

## What it covers

| Feature | Names | Guide |
| --- | --- | --- |
| Tool annotations | `READS`, `ADDS`, `CHANGES` | [Tools and annotations](https://docs.nimblebrain.ai/server-sdk/tools/) |
| Change announcements | `announce_resource_list_changed` | [Announcing changes](https://docs.nimblebrain.ai/server-sdk/announcing-changes/) |
| Skills | `add_skills`, `SkillDefinition` | [Skills](https://docs.nimblebrain.ai/server-sdk/skills/) |
| Facets | `facet_meta`, `facet_count` | [Facets](https://docs.nimblebrain.ai/server-sdk/facets/) |
| Lifecycle handlers | `add_lifecycle_extension` | [Lifecycle](https://docs.nimblebrain.ai/server-sdk/lifecycle/) |
| Host resources | `host(ctx).read`, `host(ctx).list` | [Host resources](https://docs.nimblebrain.ai/server-sdk/host-resources/) |
| The MCP Server Card | `add_server_card`, `Placement` | [Server Card](https://docs.nimblebrain.ai/server-sdk/server-card/) |
| Listing rows and record ids | `listing_row`, `new_prefixed_id` | [Tools and annotations](https://docs.nimblebrain.ai/server-sdk/tools/#listing-rows) |
| The error contract | `ServiceError`, `to_tool_error`, `add_error_contract` | [Errors](https://docs.nimblebrain.ai/server-sdk/errors/) |
| Test helpers | `served_skills`, `served_facets`, `assert_bounded_rows` | [Testing](https://docs.nimblebrain.ai/server-sdk/testing/) |

Every public name is in the [API reference](https://docs.nimblebrain.ai/server-sdk/reference/).

## Extras

Three optional extras add what only some servers need. The core imports none of them; a
subpackage imported without its extra raises an `ImportError` that names the extra.

| Install | Subpackage | For | Guide |
| --- | --- | --- | --- |
| `nimblebrain-server-sdk[db]` | `nimblebrain_server_sdk.db` | A Postgres database shared by many tenants and workspaces, isolated by row-level security | [Data](https://docs.nimblebrain.ai/server-sdk/data/) |
| `nimblebrain-server-sdk[observability]` | `nimblebrain_server_sdk.observability` | Metrics, structured logs and traces | [Observability](https://docs.nimblebrain.ai/server-sdk/observability/) |
| `nimblebrain-server-sdk[outbox]` | `nimblebrain_server_sdk.outbox` | Notifications the host polls; installs `[db]` and `[observability]` | [Notifications](https://docs.nimblebrain.ai/server-sdk/notifications/) |

### `[db]` in brief

Isolation is enforced by Postgres row-level security, not by `WHERE` clauses, so a forgotten
filter cannot leak. Identity comes only from the `x-tenant-id` and `x-workspace-id` headers
NimbleBrain's edge injects; never from a tool argument or a request body.

<!-- example: examples/db_notes.py -->
```python
"""A server that keeps its notes in Postgres, isolated per tenant and workspace by RLS."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import sqlalchemy as sa
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers

from nimblebrain_server_sdk import ADDS, READS, add_error_contract
from nimblebrain_server_sdk.db import SecuredDatabase, security_context_from_edge_headers

# NOTES_DATABASE_URL=postgresql+asyncpg://notes_app:...@host:5432/notes  (the app role)
db = SecuredDatabase(url_env="NOTES_DATABASE_URL", prefix="NOTES")

metadata = sa.MetaData()
notes = sa.Table(
    "notes",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True),
    sa.Column("tenant_id", sa.Text, nullable=False),
    sa.Column("workspace_id", sa.Text, nullable=False),
    sa.Column("text", sa.Text, nullable=False),
)


@asynccontextmanager
async def lifespan(_: FastMCP) -> AsyncGenerator[None]:
    db.check()  # the pool settings are valid
    await db.check_role()  # the role is one row-level security applies to
    yield
    await db.dispose()


mcp = FastMCP("notes", lifespan=lifespan)
add_error_contract(mcp)  # a missing identity is `auth_required`, a full pool `rate_limited`


@mcp.tool(annotations=ADDS)
async def add_note(text: str) -> dict[str, bool]:
    """Add a note to the caller's workspace."""
    ctx = security_context_from_edge_headers(get_http_headers())  # AuthError when absent
    async with db.session(ctx) as conn:  # admitted, then bound to ctx for RLS
        await conn.execute(notes.insert().values(**ctx.identity_columns(), text=text))
    return {"saved": True}


@mcp.tool(annotations=READS)
async def list_notes() -> list[str]:
    """List the notes the caller's workspace can read."""
    ctx = security_context_from_edge_headers(get_http_headers())
    async with db.session(ctx) as conn:  # no WHERE clause: the policy filters the rows
        return list((await conn.execute(sa.select(notes.c.text))).scalars())
```

Three things a first run needs:

- **The URL scheme is `postgresql+asyncpg://`.** The engine is SQLAlchemy's async engine on
  asyncpg; a bare `postgresql://` URL selects a driver the extra does not install.
- **The server connects as an app role that is `NOSUPERUSER` and `NOBYPASSRLS`.** Postgres
  applies no policy to a superuser, so the server refuses to start as one (`UnsafeRoleError`).
  The migration below creates the role and grants it the table and its sequence.
- **A migration executes the policy one statement at a time.** asyncpg refuses several
  commands in one execute, so loop over `rls_policy_statements(table)`.

A local Postgres, and the migration that prepares it:

```bash
docker run -d --name notes-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16
export MIGRATION_DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/postgres
export NOTES_APP_PASSWORD=notes-local-only
uv run python db_migrate.py
export NOTES_DATABASE_URL=postgresql+asyncpg://notes_app:$NOTES_APP_PASSWORD@127.0.0.1:5432/postgres
```

<!-- example: examples/db_migrate.py -->
```python
"""Create the notes table, its RLS policy, and the role the server connects as.

Run it as a role that owns the schema (locally, the `postgres` superuser):

    MIGRATION_DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:5432/postgres \
    NOTES_APP_PASSWORD=... python db_migrate.py
"""

import asyncio
import os

import sqlalchemy as sa
from db_notes import metadata
from sqlalchemy.ext.asyncio import create_async_engine

from nimblebrain_server_sdk.db import rls_policy_statements

APP_ROLE = "notes_app"


async def migrate(url: str, app_password: str) -> None:
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
        for statement in rls_policy_statements("notes"):  # asyncpg runs one statement a call
            await conn.execute(sa.text(statement))
        # The app role: row-level security does not apply to a superuser or BYPASSRLS role,
        # and the server refuses to start as one.
        exists = await conn.scalar(
            sa.text("SELECT 1 FROM pg_roles WHERE rolname = :role"), {"role": APP_ROLE}
        )
        verb = "ALTER" if exists else "CREATE"
        password = app_password.replace("'", "''")
        await conn.execute(
            sa.text(f"{verb} ROLE {APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{password}'")
        )
        await conn.execute(sa.text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO {APP_ROLE}"))
        await conn.execute(sa.text(f"GRANT USAGE ON SEQUENCE notes_id_seq TO {APP_ROLE}"))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(migrate(os.environ["MIGRATION_DATABASE_URL"], os.environ["NOTES_APP_PASSWORD"]))
```

In a test, the in-memory `fastmcp.Client(mcp)` sends no headers, so every call is refused as
`auth_required`. `nimblebrain_server_sdk.db.testing.edge_client` connects a client that sends
the identity headers the way the edge does:

<!-- example: examples/test_db_notes.py -->
```python
"""The Postgres notes server under a verified identity, against a real Postgres.

Needs a superuser URL in DB_TEST_URL, as the SDK's own database tests do; skipped without it.
"""

import os
from collections.abc import AsyncIterator

import pytest
import sqlalchemy as sa
from db_migrate import APP_ROLE, migrate
from db_notes import db, mcp
from fastmcp import Client
from sqlalchemy.ext.asyncio import create_async_engine

from nimblebrain_server_sdk.db.testing import edge_client
from nimblebrain_server_sdk.testing import Mode

ADMIN_URL = os.environ.get("DB_TEST_URL")
PASSWORD = "notes-test-only"  # noqa: S105

pytestmark = pytest.mark.skipif(ADMIN_URL is None and not os.environ.get("CI"), reason="no DB")


@pytest.fixture(autouse=True)
async def database(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[None]:
    assert ADMIN_URL is not None, "DB_TEST_URL is not set"
    admin = create_async_engine(ADMIN_URL)
    async with admin.begin() as conn:
        await conn.execute(sa.text("DROP TABLE IF EXISTS notes"))
    await migrate(ADMIN_URL, PASSWORD)
    app_url = sa.make_url(ADMIN_URL).set(username=APP_ROLE, password=PASSWORD)
    monkeypatch.setenv("NOTES_DATABASE_URL", app_url.render_as_string(hide_password=False))
    yield
    await db.dispose()
    async with admin.begin() as conn:
        await conn.execute(sa.text("DROP TABLE IF EXISTS notes"))
    await admin.dispose()


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_a_workspace_reads_only_its_own_notes(mode: Mode) -> None:
    async with edge_client(mcp, tenant_id="t1", workspace_id="ws_a", mode=mode) as ws_a:
        await ws_a.call_tool("add_note", {"text": "from a"})
        assert (await ws_a.call_tool("list_notes", {})).data == ["from a"]
    async with edge_client(mcp, tenant_id="t1", workspace_id="ws_b", mode=mode) as ws_b:
        assert (await ws_b.call_tool("list_notes", {})).data == []
    async with edge_client(mcp, tenant_id="t2", workspace_id="ws_a", mode=mode) as other_tenant:
        assert (await other_tenant.call_tool("list_notes", {})).data == []


async def test_a_call_with_no_identity_is_auth_required() -> None:
    async with Client(mcp) as client:  # the in-memory client sends no identity headers
        result = await client.call_tool("list_notes", {}, raise_on_error=False)
    assert result.is_error
    assert result.structured_content is not None
    assert result.structured_content["error"]["code"] == "auth_required"
```

Outside a test, serve it over HTTP (`mcp.run(transport="http")`) and send both headers from
the client, standing where the edge stands:
`Client(StreamableHttpTransport(url, headers={"x-tenant-id": "t1", "x-workspace-id": "ws_a"}))`.

The [data guide](https://docs.nimblebrain.ai/server-sdk/data/) covers the three policy shapes, the pool and per-workspace
admission, and `system_session`.

## Compatibility

| | Supported |
| --- | --- |
| Python | 3.13, 3.14 |
| FastMCP | 4.0 and later (no ceiling; a weekly run tests the newest release) |
| `mcp` | 2.0 up to, not including, 2.4 (each new minor is admitted by an SDK release) |
| MCP protocol | 2026-07-28 and 2025-11-25, except host resources, which need a 2025-era connection |
| Postgres (`[db]`, `[outbox]`) | 13 and later |

**Stability.** `0.x` is pre-stable: a minor release (`0.7` to `0.8`) may change the Python
API, and a patch release never does. The `ai.nimblebrain/*` identifiers and `_meta` keys are a
wire contract with the host and do not change within a major. The SQL `[db]` renders is a schema
contract: a change to it ships with its own migration note.

**Deprecation.** A public name is deprecated for at least one minor release before it is
removed: it keeps working, emits a `DeprecationWarning` that names its replacement, and is
listed under "Deprecated" in the [changelog](https://github.com/NimbleBrainInc/nimblebrain/blob/main/packages/server-sdk-py/CHANGELOG.md).

## Contributing

See [CONTRIBUTING.md](https://github.com/NimbleBrainInc/nimblebrain/blob/main/packages/server-sdk-py/CONTRIBUTING.md)
for the checks, the conformance suite and how a release is cut.
