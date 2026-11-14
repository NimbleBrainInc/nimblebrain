"""The negative-access suite every ``nimblebrain_server_sdk.db`` adopter must pass.

The outbox is a tenant/workspace table like any other, so the wall around it is
the RLS policy and not a ``WHERE`` clause the library remembered to write. Each
test below asserts the policy specifically: it reads or writes **without** a
workspace filter, so the only thing that can produce the expected answer is
Postgres refusing.

Meaningful only against a non-superuser role without ``BYPASSRLS`` — which is
what ``conftest`` provisions, and why these run against a real database.
"""

from __future__ import annotations

import pytest
import sqlalchemy as sa
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import create_async_engine

from nimblebrain_server_sdk.outbox import emit, read
from tests.outbox.conftest import TABLE, count_rows, make_ctx, session
from tests.outbox.test_outbox import envelope, ids, poll, stamped_at

WS_A = make_ctx("ws_a")
WS_B = make_ctx("ws_b")
OTHER_TENANT = make_ctx("ws_a", tenant_id="tenant_b")


async def test_a_workspace_cannot_read_another_workspaces_rows(engine) -> None:
    async with session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_a"))

    # Unfiltered count: whatever comes back, the SELECT policy chose it.
    async with session(engine, WS_B) as conn:
        assert await count_rows(conn) == 0
    async with session(engine, WS_A) as conn:
        assert await count_rows(conn) == 1


async def test_a_tenant_cannot_read_another_tenants_rows(engine) -> None:
    """Same workspace id, different tenant: the hard wall, never crossed."""
    async with session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_a"))
    async with session(engine, OTHER_TENANT) as conn:
        assert await count_rows(conn) == 0


async def test_one_workspaces_cursor_replayed_as_another_returns_nothing(engine) -> None:
    """A leaked cursor is not a capability: it names a position, not a right."""
    start = await poll(engine, WS_A)
    async with session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_a"))
    assert ids(await poll(engine, WS_A, start["cursor"])) == ["evt_a"]

    stolen = await poll(engine, WS_B, start["cursor"])
    assert stolen["events"] == []


async def test_an_emit_stamped_for_another_workspace_is_refused_by_the_policy(engine) -> None:
    """Not by anything in Python: the check is the INSERT policy's ``WITH CHECK``.

    ``emit`` stamps the row from the context it is given, so a caller that hands
    it the wrong one writes a row the session's own identity does not admit —
    and Postgres, not this library, is what says no.
    """
    with pytest.raises(DBAPIError) as raised:
        async with session(engine, WS_B) as conn:
            await emit(conn, WS_A, envelope("evt_a"))
    assert "row-level security policy" in str(raised.value)

    async with session(engine, WS_A) as conn:
        assert await count_rows(conn) == 0


async def test_a_read_grant_does_not_carry_a_write(engine) -> None:
    """B may read A's outbox with an explicit grant, and still may not append to it."""
    async with session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_a"))

    granted = make_ctx("ws_b", allowed_workspaces={"ws_a"})
    async with session(engine, granted) as conn:
        assert await count_rows(conn) == 1  # the read grant is honoured

    with pytest.raises(DBAPIError, match="row-level security policy"):
        async with session(engine, granted) as conn:
            await emit(conn, WS_A, envelope("evt_b"))


async def test_a_read_grant_does_not_widen_the_poll(engine) -> None:
    """The poll is per active workspace even where the policy would allow more.

    A grant exists so a principal can *look* across workspaces; a notification
    stream is addressed to one, and the host keeps one cursor per
    ``(workspace, connector)``. Widening it silently would hand B's poll A's
    events under B's cursor.
    """
    async with session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_a"))

    granted = make_ctx("ws_b", allowed_workspaces={"ws_a"})
    assert (await poll(engine, granted))["events"] == []
    async with session(engine, granted) as conn:
        result = await read(conn, granted, cursor=None)
    assert result["events"] == []

    # And the bootstrap's WRITE is scoped the same way its read is: B's first poll must
    # not start a seven-day retention clock on A's undelivered backlog.
    #
    # TWO independent layers hold this, and this assertion fires only if BOTH fail.
    # `rls_policy_sql` splits per command and binds UPDATE to `app.workspace_id` — the
    # active workspace — so a read grant cannot relabel or age a granted workspace's
    # rows; and `_stamp_skipped` carries its own `workspace_id = ctx.workspace_id`
    # predicate. Either one alone already excludes `evt_a`, so neither is the redundant
    # one: widen the policy to the allowed set and this still passes, drop the predicate
    # and it still passes. Which layer is load-bearing depends on the caller — under
    # `app.role = 'system'` the policy stops scoping by workspace at all (`write_ws` is
    # `is_active OR is_system`) and the library predicate is the only wall left.
    assert await stamped_at(engine, WS_A, "evt_a") is None


async def test_an_unscoped_session_sees_nothing(engine, provisioned_db) -> None:
    """Default deny: with no context bound, ``current_setting`` is NULL and no row matches."""
    async with session(engine, WS_A) as conn:
        await emit(conn, WS_A, envelope("evt_a"))

    unscoped = create_async_engine(provisioned_db)
    try:
        async with unscoped.begin() as conn:
            assert await conn.scalar(sa.select(sa.func.count()).select_from(TABLE)) == 0
    finally:
        await unscoped.dispose()
