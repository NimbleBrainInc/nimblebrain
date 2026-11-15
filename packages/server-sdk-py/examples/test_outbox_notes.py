"""A shared note reaches the host's next poll, and only in its own workspace.

Needs a superuser URL in DB_TEST_URL, as the SDK's own database tests do; skipped without it.
"""

import json
import os
from collections.abc import AsyncIterator
from typing import Any

import pytest
import sqlalchemy as sa
from db_migrate import APP_ROLE, migrate
from db_notes import db
from fastmcp import Client
from outbox_migrate import OUTBOX_TABLE, migrate_outbox
from outbox_notes import OUTBOX, mcp
from sqlalchemy.ext.asyncio import create_async_engine

from nimblebrain_server_sdk.db.testing import edge_client

ADMIN_URL = os.environ.get("DB_TEST_URL")
PASSWORD = "notes-test-only"  # noqa: S105
TABLES = f"notes, {OUTBOX_TABLE.name}, {OUTBOX_TABLE.name}_state"

pytestmark = pytest.mark.skipif(ADMIN_URL is None and not os.environ.get("CI"), reason="no DB")


@pytest.fixture(autouse=True)
async def database(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[None]:
    assert ADMIN_URL is not None, "DB_TEST_URL is not set"
    admin = create_async_engine(ADMIN_URL)
    async with admin.begin() as conn:
        await conn.execute(sa.text(f"DROP TABLE IF EXISTS {TABLES}"))
    await migrate(ADMIN_URL, PASSWORD)
    await migrate_outbox(ADMIN_URL)
    app_url = sa.make_url(ADMIN_URL).set(username=APP_ROLE, password=PASSWORD)
    monkeypatch.setenv("NOTES_DATABASE_URL", app_url.render_as_string(hide_password=False))
    yield
    await db.dispose()
    async with admin.begin() as conn:
        await conn.execute(sa.text(f"DROP TABLE IF EXISTS {TABLES}"))
    await admin.dispose()


async def poll(client: Client, cursor: str | None = None) -> dict[str, Any]:
    uri = OUTBOX if cursor is None else f"{OUTBOX}?cursor={cursor}"
    (content,) = await client.read_resource(uri)
    return json.loads(getattr(content, "text", ""))


async def test_a_shared_note_is_in_the_next_poll() -> None:
    async with edge_client(mcp, tenant_id="t1", workspace_id="ws_a") as ws_a:
        start = await poll(ws_a)  # a first poll starts from now: a cursor and no history
        assert start["events"] == []
        await ws_a.call_tool("add_note", {"text": "ship it"})
        await ws_a.call_tool("share_note", {"note_id": 1, "with_person": "Sam"})
        page = await poll(ws_a, start["cursor"])
    (event,) = page["events"]
    assert event["name"] == "note.shared"
    assert event["data"] == {"note_id": 1, "with": "Sam"}
    assert event["_meta"]["ai.nimblebrain/notification"]["title"] == "A note was shared with Sam"

    async with edge_client(mcp, tenant_id="t1", workspace_id="ws_b") as ws_b:
        assert (await poll(ws_b))["events"] == []
