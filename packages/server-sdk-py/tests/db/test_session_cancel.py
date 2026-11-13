"""A session left by cancellation returns its connection to the pool — REAL Postgres.

An MCP call runs under an anyio cancel scope, whose cancellation is level-triggered: every
await inside a cancelled scope raises again. Without a shield, the session's own rollback is
cancelled on the way out and SQLAlchemy terminates the connection (``Exception terminating
connection``), so a pod loses a connection per cancelled call. Each test here cancels a session
through a cancel scope and then checks that the very same backend connection serves the next
checkout, which is only true of a connection the pool got back. A query interrupted mid-flight
is the exception, and its own test says why.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

import anyio
import pytest

# The cleanup bound is read where the shielded exit lives, in the pgbulkhead core.
from pgbulkhead import session as session_mod
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine
from sqlalchemy.pool import QueuePool

from nimblebrain_server_sdk.db import (
    SecurityContext,
    WorkspaceLimiter,
    org_session,
    secured_session,
    system_session,
)
from nimblebrain_server_sdk.db.admission import admitted_session

CTX = SecurityContext(tenant_id="tenant-a", workspace_id="ws-a")

Opener = Callable[[AsyncEngine], AbstractAsyncContextManager[AsyncConnection]]

_OPENERS: dict[str, Opener] = {
    "secured_session": lambda engine: secured_session(engine, CTX),
    "system_session": system_session,
    "org_session": lambda engine: org_session(engine, "org-a"),
}


async def _backend_pid(conn: AsyncConnection) -> int:
    return (await conn.execute(text("SELECT pg_backend_pid()"))).scalar_one()


async def _cancel_inside(
    open_session: Callable[[], AbstractAsyncContextManager[AsyncConnection]],
    *,
    mid_query: bool,
) -> int:
    """Open a session, cancel its scope from outside while the body waits, return its pid."""
    started = anyio.Event()
    pid: dict[str, int] = {}

    async def body() -> None:
        async with open_session() as conn:
            pid["v"] = await _backend_pid(conn)
            await conn.execute(text("SELECT set_config('app.probe', 'held', true)"))
            started.set()
            if mid_query:
                await conn.execute(text("SELECT pg_sleep(30)"))
            await anyio.sleep_forever()

    with anyio.CancelScope() as scope:
        async with anyio.create_task_group() as tg:

            async def cancel_once_started() -> None:
                await started.wait()
                await anyio.sleep(0.05)
                scope.cancel()

            tg.start_soon(cancel_once_started)
            await body()
    assert scope.cancelled_caught
    return pid["v"]


def _checked_out(engine: AsyncEngine) -> int:
    pool = engine.pool
    assert isinstance(pool, QueuePool)
    return pool.checkedout()


def _terminations(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if "terminating connection" in r.getMessage()]


@pytest.mark.parametrize("opener", list(_OPENERS))
async def test_cancelled_session_returns_its_connection(
    pg_engine: AsyncEngine, caplog: pytest.LogCaptureFixture, opener: str
) -> None:
    caplog.set_level(logging.ERROR, logger="sqlalchemy.pool")
    open_session = _OPENERS[opener]

    pid = await _cancel_inside(lambda: open_session(pg_engine), mid_query=False)

    assert _checked_out(pg_engine) == 0
    assert _terminations(caplog) == []
    async with pg_engine.connect() as conn:
        # The same backend: the pool got the connection back rather than replacing it...
        assert await _backend_pid(conn) == pid
        # ...rolled back, so nothing the cancelled transaction set survives on it.
        probe = await conn.execute(text("SELECT current_setting('app.probe', true)"))
        assert probe.scalar() in (None, "")


async def test_session_cancelled_mid_query_still_leaves_the_pool_whole(
    pg_engine: AsyncEngine,
) -> None:
    """A query interrupted in flight leaves its connection in an unknown protocol state, and
    SQLAlchemy discards it from inside the interrupted ``execute``, before the session's exit
    runs. That loss is the driver's to decide; what the exit owes is that nothing stays
    checked out and the next checkout gets a working connection."""
    pid = await _cancel_inside(lambda: secured_session(pg_engine, CTX), mid_query=True)

    assert _checked_out(pg_engine) == 0
    async with pg_engine.connect() as conn:
        assert isinstance(await _backend_pid(conn), int)
    assert isinstance(pid, int)


async def test_cancelled_admitted_session_releases_its_slot_and_connection(
    pg_engine: AsyncEngine, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.ERROR, logger="sqlalchemy.pool")
    limiter = WorkspaceLimiter(limit=1, wait_seconds=0.5)

    def open_admitted() -> AbstractAsyncContextManager[AsyncConnection]:
        return admitted_session(limiter, CTX, lambda ctx: secured_session(pg_engine, ctx))

    # More cancelled calls than the workspace has slots: each gives its slot back.
    pids = {await _cancel_inside(open_admitted, mid_query=False) for _ in range(3)}

    assert limiter.tracked() == 0
    assert _checked_out(pg_engine) == 0
    assert _terminations(caplog) == []
    assert len(pids) == 1


async def test_completed_session_commits_and_failed_one_rolls_back(pg_engine: AsyncEngine) -> None:
    async with pg_engine.connect() as conn:
        await conn.execute(text("CREATE TEMP TABLE IF NOT EXISTS t (v int)"))
        await conn.commit()

    # A temp table lives on its connection, and the pool has one: each session reuses it.
    async with secured_session(pg_engine, CTX) as conn:
        await conn.execute(text("INSERT INTO t VALUES (1)"))
    # The body fails inside the session, so the test covers how the session exits on it.
    with pytest.raises(RuntimeError, match="the body failed"):  # noqa: PT012
        async with secured_session(pg_engine, CTX) as conn:
            await conn.execute(text("INSERT INTO t VALUES (2)"))
            raise RuntimeError("the body failed")

    async with pg_engine.connect() as conn:
        rows = (await conn.execute(text("SELECT v FROM t ORDER BY v"))).scalars().all()
    assert rows == [1]
    assert _checked_out(pg_engine) == 0


async def test_unshielded_exit_terminates_the_connection(
    pg_engine: AsyncEngine, caplog: pytest.LogCaptureFixture
) -> None:
    """The control: the same cancellation through a bare ``engine.begin()`` loses the
    connection, which is what the shield in the sessions above prevents. If this starts
    failing, SQLAlchemy's exit has changed and the tests above no longer prove the shield."""
    caplog.set_level(logging.ERROR, logger="sqlalchemy.pool")

    def bare() -> AbstractAsyncContextManager[AsyncConnection]:
        return pg_engine.begin()

    pid = await _cancel_inside(bare, mid_query=False)

    assert _terminations(caplog) != []
    async with pg_engine.connect() as conn:
        assert await _backend_pid(conn) != pid


async def test_commit_past_the_bound_raises_and_writes_nothing(
    pg_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A commit that overruns the cleanup bound raises ``TimeoutError`` rather than being
    skipped, so the caller never reads a lost write as success. A deferred constraint trigger
    makes the COMMIT itself slow; the table is a real one because a connection the timeout
    discards takes its temp tables with it."""
    table = "sdk_db_slow_commit"
    async with pg_engine.connect() as conn:
        await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
        await conn.execute(text(f"CREATE TABLE {table} (v int)"))
        await conn.execute(
            text(
                f"CREATE OR REPLACE FUNCTION {table}_sleep() RETURNS trigger"
                " LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NULL; END $$"
            )
        )
        await conn.execute(
            text(
                f"CREATE CONSTRAINT TRIGGER {table}_slow AFTER INSERT ON {table}"
                f" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {table}_sleep()"
            )
        )
        await conn.commit()
    monkeypatch.setattr(session_mod, "CLEANUP_TIMEOUT_SECONDS", 0.2)
    try:
        with pytest.raises(TimeoutError):
            async with secured_session(pg_engine, CTX) as conn:
                await conn.execute(text(f"INSERT INTO {table} VALUES (1)"))

        monkeypatch.undo()
        async with pg_engine.connect() as conn:
            count = (await conn.execute(text(f"SELECT count(*) FROM {table}"))).scalar_one()
        assert count == 0
        assert _checked_out(pg_engine) == 0
    finally:
        monkeypatch.undo()
        async with pg_engine.connect() as conn:
            await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
            await conn.execute(text(f"DROP FUNCTION IF EXISTS {table}_sleep()"))
            await conn.commit()
