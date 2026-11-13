"""Fixtures for the Postgres suites — REAL Postgres only.

What the suites test is how SQLAlchemy, Postgres and row-level security behave together, which
a fake has no notion of. Every fixture here needs a Postgres at ``DB_TEST_URL`` and **skips**
without one, except under CI, where a skip would report success having run nothing, so it fails
instead. The other suites ask for no database.

``DB_TEST_URL`` names a superuser. The suites run their sessions as :data:`APP_ROLE`, a login
role with neither ``SUPERUSER`` nor ``BYPASSRLS``, because that is the only kind of role a
pooled engine accepts and the only kind the policies hold against. The superuser engine
(``pg_admin``) only sets the suites up: it is meant to bypass, so it opts out of the role check
explicitly. ``pg_bypass_url`` names a ``BYPASSRLS`` role that is not a superuser.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import make_url, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

from nimblebrain_server_sdk.db import PoolSettings, create_pooled_engine

_URL = os.environ.get(
    "DB_TEST_URL",
    # 127.0.0.1, not `localhost`: where the resolver prefers ::1, asyncpg stalls its connect
    # timeout before the skip.
    "postgresql+asyncpg://postgres@127.0.0.1:5432/postgres",
)

#: A role row-level security applies to, as a server's app role is.
APP_ROLE = "sdk_app"
#: A role that bypasses row-level security without being a superuser.
BYPASS_ROLE = "sdk_bypass"
_ROLES = {APP_ROLE: "NOSUPERUSER NOBYPASSRLS", BYPASS_ROLE: "NOSUPERUSER BYPASSRLS"}
# Set on both test roles, so they log in under password authentication as well as trust.
_PASSWORD = "sdk-test-only"  # noqa: S105

#: A one-connection pool, as a server builds it, so a terminated connection shows.
SMALL = PoolSettings(pool_size=1, max_overflow=2, workspace_concurrency=1)


def _url_as(role: str) -> str:
    return make_url(_URL).set(username=role, password=_PASSWORD).render_as_string(False)


@pytest_asyncio.fixture
async def pg_admin() -> AsyncIterator[AsyncEngine]:
    """The superuser engine that creates the test roles and sets each suite up."""
    engine = create_pooled_engine(_URL, SMALL, refuse_bypass_roles=False)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except (SQLAlchemyError, OSError):
        await engine.dispose()
        if os.environ.get("CI"):
            pytest.fail(f"no Postgres reachable at {_URL!r} (DB_TEST_URL)")
        pytest.skip(f"no Postgres reachable at {_URL!r}; set DB_TEST_URL")
    try:
        async with engine.begin() as conn:
            for role, attributes in _ROLES.items():
                exists = await conn.scalar(
                    text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}
                )
                verb = "ALTER" if exists else "CREATE"
                await conn.execute(
                    text(f"{verb} ROLE {role} LOGIN {attributes} PASSWORD '{_PASSWORD}'")
                )
        yield engine
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def pg_admin_url(pg_admin: AsyncEngine) -> str:
    """The superuser URL ``DB_TEST_URL`` names (skips like ``pg_admin`` without one)."""
    return _URL


@pytest_asyncio.fixture
async def pg_url(pg_admin: AsyncEngine) -> str:
    """The URL of :data:`APP_ROLE`, the role a server's sessions run as."""
    return _url_as(APP_ROLE)


@pytest_asyncio.fixture
async def pg_bypass_url(pg_admin: AsyncEngine) -> str:
    """The URL of :data:`BYPASS_ROLE`, a ``BYPASSRLS`` role that is not a superuser."""
    return _url_as(BYPASS_ROLE)


@pytest_asyncio.fixture
async def pg_engine(pg_url: str) -> AsyncIterator[AsyncEngine]:
    """A one-connection pooled engine as the app role, built the way a server builds one."""
    engine = create_pooled_engine(pg_url, SMALL)
    try:
        yield engine
    finally:
        await engine.dispose()
