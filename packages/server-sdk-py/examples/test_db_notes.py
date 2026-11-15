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
