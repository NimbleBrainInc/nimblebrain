"""Fixtures for the session-exit suite — REAL Postgres only.

What the suite tests is whether SQLAlchemy returns a connection to the pool or terminates it
when a session is left by cancellation, which a fake has no notion of. ``pg_engine`` needs a
Postgres at ``DB_TEST_URL`` and **skips** without one, except under CI, where a
skip would report success having run nothing, so it fails instead. The other suites ask for
no database.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

from nimblebrain_server_sdk.db import PoolSettings, create_pooled_engine

_URL = os.environ.get(
    "DB_TEST_URL",
    # 127.0.0.1, not `localhost`: where the resolver prefers ::1, asyncpg stalls its connect
    # timeout before the skip.
    "postgresql+asyncpg://postgres@127.0.0.1:5432/postgres",
)


@pytest_asyncio.fixture
async def pg_url(pg_engine: AsyncEngine) -> str:
    """The reachable test Postgres URL (skips like ``pg_engine`` without one)."""
    return _URL


@pytest_asyncio.fixture
async def pg_engine() -> AsyncIterator[AsyncEngine]:
    """A one-connection pooled engine, as a server builds it, so a terminated connection shows."""
    engine = create_pooled_engine(
        _URL, PoolSettings(pool_size=1, max_overflow=2, workspace_concurrency=1)
    )
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except (SQLAlchemyError, OSError):
        await engine.dispose()
        if os.environ.get("CI"):
            pytest.fail(f"no Postgres reachable at {_URL!r} (DB_TEST_URL)")
        pytest.skip(f"no Postgres reachable at {_URL!r}; set DB_TEST_URL")
    try:
        yield engine
    finally:
        await engine.dispose()
