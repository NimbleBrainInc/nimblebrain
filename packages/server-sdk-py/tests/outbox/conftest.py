"""Fixtures for the outbox suites — REAL Postgres only.

Two of the three things this library exists to guarantee do not exist outside a
real Postgres, so neither does a meaningful test of them:

  * **The snapshot horizon.** ``pg_snapshot_xmin(pg_current_snapshot())`` is the
    mechanism. A fake with an in-memory list has no transactions to be in
    flight, so the commit-order gap — the whole reason for the design — cannot
    be reproduced against one, and a suite that passes against it proves
    nothing.
  * **The RLS policy.** It is the enforcement boundary, and only when the
    connection is a **non-superuser role without ``BYPASSRLS``**. A superuser
    fixture makes every negative-access assertion a tautology.

So this provisions exactly that: a
throwaway ``NOSUPERUSER NOBYPASSRLS`` role, a throwaway database it owns, and
the library's own :func:`~nimblebrain_server_sdk.outbox.outbox_ddl` applied as that role — which
also means the DDL an adopter pastes into a migration is the DDL every test
below runs against.

With no admin Postgres reachable the suite **skips loudly** rather than passing
having run nothing, and under CI it fails.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from nimblebrain_server_sdk.db import SecurityContext, secured_session
from nimblebrain_server_sdk.outbox import outbox_ddl, outbox_table

# Superuser admin connection — provisions and drops the throwaway DB + role only. The same
# variable and default as the ``[db]`` suites (``tests/db/conftest.py``).
_ADMIN_URL = os.environ.get(
    "DB_TEST_URL",
    "postgresql+asyncpg://postgres@127.0.0.1:5432/postgres",
)

# Unique per run so concurrent runs never collide on the cluster-wide names.
_SUFFIX = uuid.uuid4().hex[:10]
_APP_ROLE = f"notify_outbox_test_{_SUFFIX}"
_APP_PASSWORD = "notify_outbox_test_pw"  # noqa: S105 - a throwaway test role
_APP_DB = f"notify_outbox_test_{_SUFFIX}"
# Same host and port as the admin DSN, as the throwaway app role.
_APP_URL = str(
    sa.engine.make_url(_ADMIN_URL).set(username=_APP_ROLE, password=_APP_PASSWORD, database=_APP_DB)
)

#: The table under test. Built on its own metadata, with the default name, so
#: ``emit`` / ``read`` calls that pass no ``table=`` exercise the default path
#: against exactly these columns.
TABLE = outbox_table(sa.MetaData())
STATE = TABLE.metadata.tables[f"{TABLE.name}_state"]


def _admin_engine() -> AsyncEngine:
    """A short-lived superuser engine for provisioning DDL only."""
    return create_async_engine(_ADMIN_URL, isolation_level="AUTOCOMMIT")


async def _admin_reachable() -> bool:
    try:
        engine = _admin_engine()
        try:
            async with engine.connect() as conn:
                await conn.execute(sa.text("SELECT 1"))
        finally:
            await engine.dispose()
        return True
    except (SQLAlchemyError, OSError):
        return False


async def _provision() -> None:
    engine = _admin_engine()
    try:
        async with engine.connect() as conn:
            # NOSUPERUSER NOBYPASSRLS is the load-bearing part: either would
            # void RLS and make the negative-access suite meaningless.
            await conn.execute(
                sa.text(
                    f"CREATE ROLE {_APP_ROLE} LOGIN PASSWORD '{_APP_PASSWORD}' "
                    "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE"
                )
            )
            await conn.execute(sa.text(f"CREATE DATABASE {_APP_DB} OWNER {_APP_ROLE}"))
    finally:
        await engine.dispose()

    # The DDL runs as the app role, which owns the tables. FORCE ROW LEVEL
    # SECURITY in the policy means ownership does not weaken any assertion.
    app = create_async_engine(_APP_URL, isolation_level="AUTOCOMMIT")
    try:
        async with app.connect() as conn:
            for statement in outbox_ddl(TABLE):
                await conn.execute(sa.text(statement))
    finally:
        await app.dispose()


async def _deprovision() -> None:
    engine = _admin_engine()
    try:
        async with engine.connect() as conn:
            await conn.execute(
                sa.text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :db AND pid <> pg_backend_pid()"
                ),
                {"db": _APP_DB},
            )
            await conn.execute(sa.text(f"DROP DATABASE IF EXISTS {_APP_DB}"))
            await conn.execute(sa.text(f"DROP ROLE IF EXISTS {_APP_ROLE}"))
    finally:
        await engine.dispose()


# The suite must run alone against a Postgres instance — see "Tests" in the README
# for why (`pg_snapshot_xmin` is instance-wide) and what the failures look like.


@pytest.fixture(scope="session")
def provisioned_db() -> Iterator[str]:
    """Provision role + database, apply the outbox DDL, yield the app URL."""
    if not asyncio.run(_admin_reachable()):
        # Under CI a skip would report success having run nothing.
        if os.environ.get("CI"):
            pytest.fail(f"No admin Postgres reachable at {_ADMIN_URL!r} (DB_TEST_URL)")
        pytest.skip(
            f"No admin Postgres reachable at {_ADMIN_URL!r}. These suites test a "
            "snapshot horizon and an RLS policy, neither of which exists without a "
            "real database (set DB_TEST_URL to override)."
        )
    asyncio.run(_provision())
    try:
        yield _APP_URL
    finally:
        asyncio.run(_deprovision())


@pytest_asyncio.fixture
async def engine(provisioned_db: str) -> AsyncIterator[AsyncEngine]:
    """An engine as the NON-superuser app role, fresh per test.

    Built and disposed per test because an async engine's pool is bound to the
    event loop it was created on, and pytest-asyncio gives each test its own.
    """
    built = create_async_engine(provisioned_db)
    try:
        yield built
    finally:
        await built.dispose()


@pytest_asyncio.fixture(autouse=True)
async def _clean_tables(request: pytest.FixtureRequest) -> AsyncIterator[None]:
    """Empty both tables before each test that touches a database.

    TRUNCATE is an owner privilege rather than a row operation, so it is not
    subject to the RLS policy and clears every tenant's rows. Tests that ask for
    no database fixture — the envelope, cursor and DDL suites are pure — are
    left alone, so they still run where no Postgres does.
    """
    if "provisioned_db" not in request.fixturenames:
        yield
        return
    built = create_async_engine(request.getfixturevalue("provisioned_db"))
    try:
        async with built.begin() as conn:
            await conn.execute(sa.text(f"TRUNCATE {TABLE.name}, {STATE.name}"))
    finally:
        await built.dispose()
    yield


def make_ctx(
    workspace_id: str = "ws_a",
    *,
    tenant_id: str = "tenant_a",
    allowed_workspaces: set[str] | None = None,
) -> SecurityContext:
    """A verified context, the way ``security_context_from_headers`` builds one.

    v1 is active-workspace-only: the read set is exactly ``{workspace_id}``
    unless a test is deliberately modelling a cross-workspace read grant.
    """
    allowed = frozenset(allowed_workspaces or set()) | {workspace_id}
    return SecurityContext(
        tenant_id=tenant_id,
        workspace_id=workspace_id,
        allowed_workspaces=allowed,
        user_id=None,
    )


@pytest.fixture
def ctx() -> SecurityContext:
    return make_ctx()


def session(engine: AsyncEngine, ctx: SecurityContext):
    """One transaction with ``ctx`` bound — the shape of an adopter's own session factory."""
    return secured_session(engine, ctx)


async def count_rows(conn: AsyncConnection) -> int:
    """Rows the current session can see through the policy, not through a filter."""
    return await conn.scalar(sa.select(sa.func.count()).select_from(TABLE)) or 0
