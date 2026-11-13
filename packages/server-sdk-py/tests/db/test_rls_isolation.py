"""The policies enforce isolation in a real Postgres, as a role RLS applies to.

The other suites pin the SQL text; this one proves what it does. Each table gets the policy a
migration would apply, rows are seeded by the owner, and every read and write runs as
``sdk_rls_app``: a role with neither ``SUPERUSER`` nor ``BYPASSRLS``, the only kind of role the
policies hold against. Sessions run as it by setting ``role`` on each connection of an engine
built on the superuser URL (``DB_TEST_URL``); the engine is a plain one, not the pooled engine
that checks the role a connection logs in as.

Covered: cross-tenant reads are denied, cross-workspace reads are denied without a grant and
allowed with one, a write to a granted workspace is refused, an unscoped session sees nothing,
a pooled connection carries no context into the next session, the system role crosses
workspaces but not tenants, and the tenant- and org-scoped shapes hold their single key.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from nimblebrain_server_sdk.db import (
    SecurityContext,
    org_session,
    rls_policy_sql,
    rls_policy_sql_org_scoped,
    rls_policy_sql_tenant_scoped,
    secured_session,
    system_session,
)

ROLE = "sdk_rls_app"
NOTES = "sdk_rls_notes"
LEDGER = "sdk_rls_ledger"
LINKS = "sdk_rls_links"


@pytest_asyncio.fixture
async def app_engine(pg_admin: AsyncEngine, pg_admin_url: str) -> AsyncIterator[AsyncEngine]:
    """Seeded tables, and a one-connection engine whose sessions run as the non-superuser role."""
    async with pg_admin.begin() as conn:
        exists = await conn.scalar(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": ROLE})
        if not exists:
            await conn.execute(text(f"CREATE ROLE {ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS"))
        await conn.execute(text(f"GRANT {ROLE} TO CURRENT_USER"))
        for table in (NOTES, LEDGER, LINKS):
            await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
        await conn.execute(
            text(f"CREATE TABLE {NOTES} (tenant_id text, workspace_id text, body text)")
        )
        await conn.execute(
            text(f"CREATE TABLE {LEDGER} (tenant_id text, workspace_id text, body text)")
        )
        await conn.execute(text(f"CREATE TABLE {LINKS} (org_id text, body text)"))
        await conn.execute(
            text(
                f"INSERT INTO {NOTES} VALUES ('tenant-a', 'ws-a', 'a1'), ('tenant-a', 'ws-b', 'b1'),"
                " ('tenant-b', 'ws-a', 'other-tenant')"
            )
        )
        await conn.execute(
            text(
                f"INSERT INTO {LEDGER} VALUES ('tenant-a', 'ws-a', 'a'), ('tenant-b', 'ws-a', 'b')"
            )
        )
        await conn.execute(text(f"INSERT INTO {LINKS} VALUES ('org-a', 'a'), ('org-b', 'b')"))
        for statement in (
            rls_policy_sql(NOTES),
            rls_policy_sql_tenant_scoped(LEDGER),
            rls_policy_sql_org_scoped(LINKS),
        ):
            # Several statements in one string, as a migration runs it: asyncpg's simple
            # protocol takes that, a prepared statement does not.
            driver = (await conn.get_raw_connection()).driver_connection
            assert driver is not None
            await driver.execute(statement)
        for table in (NOTES, LEDGER, LINKS):
            await conn.execute(text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {ROLE}"))

    engine = create_async_engine(
        pg_admin_url,
        pool_size=1,
        max_overflow=0,
        connect_args={"server_settings": {"role": ROLE}},
    )
    try:
        yield engine
    finally:
        await engine.dispose()
        async with pg_admin.begin() as conn:
            for table in (NOTES, LEDGER, LINKS):
                await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))


def ctx(
    tenant: str = "tenant-a", workspace: str = "ws-a", *grants: str, scopes: tuple[str, ...] = ()
) -> SecurityContext:
    return SecurityContext(
        tenant_id=tenant,
        workspace_id=workspace,
        allowed_workspaces=frozenset({workspace, *grants}),
        scopes=frozenset(scopes),
    )


async def bodies(engine: AsyncEngine, context: SecurityContext, table: str = NOTES) -> list[str]:
    async with secured_session(engine, context) as conn:
        return sorted((await conn.execute(text(f"SELECT body FROM {table}"))).scalars())


async def test_sessions_run_as_a_role_rls_applies_to(app_engine: AsyncEngine) -> None:
    async with app_engine.connect() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles"
                    " WHERE rolname = current_user"
                )
            )
        ).one()
    assert tuple(row) == (ROLE, False, False)


async def test_a_read_sees_its_own_tenant_and_workspace_only(app_engine: AsyncEngine) -> None:
    assert await bodies(app_engine, ctx()) == ["a1"]


async def test_another_tenant_with_the_same_workspace_id_sees_nothing_of_it(
    app_engine: AsyncEngine,
) -> None:
    assert await bodies(app_engine, ctx("tenant-c", "ws-a")) == []
    assert await bodies(app_engine, ctx("tenant-b", "ws-a")) == ["other-tenant"]


async def test_a_read_grant_widens_reads_to_the_granted_workspace(app_engine: AsyncEngine) -> None:
    assert await bodies(app_engine, ctx("tenant-a", "ws-a", "ws-b")) == ["a1", "b1"]


async def test_a_read_grant_never_reaches_another_tenant(app_engine: AsyncEngine) -> None:
    assert await bodies(app_engine, ctx("tenant-b", "ws-a", "ws-b")) == ["other-tenant"]


async def test_a_write_to_a_granted_workspace_is_refused(app_engine: AsyncEngine) -> None:
    with pytest.raises(DBAPIError, match="row-level security"):
        async with secured_session(app_engine, ctx("tenant-a", "ws-a", "ws-b")) as conn:
            await conn.execute(text(f"INSERT INTO {NOTES} VALUES ('tenant-a', 'ws-b', 'x')"))


async def test_an_update_or_delete_cannot_touch_a_granted_workspaces_rows(
    app_engine: AsyncEngine,
) -> None:
    async with secured_session(app_engine, ctx("tenant-a", "ws-a", "ws-b")) as conn:
        deleted = await conn.execute(text(f"DELETE FROM {NOTES} WHERE workspace_id = 'ws-b'"))
        relabelled = await conn.execute(
            text(f"UPDATE {NOTES} SET workspace_id = 'ws-a' WHERE workspace_id = 'ws-b'")
        )
    assert (deleted.rowcount, relabelled.rowcount) == (0, 0)
    assert await bodies(app_engine, ctx("tenant-a", "ws-b")) == ["b1"]


async def test_a_write_to_the_active_workspace_is_admitted(app_engine: AsyncEngine) -> None:
    async with secured_session(app_engine, ctx()) as conn:
        await conn.execute(text(f"INSERT INTO {NOTES} VALUES ('tenant-a', 'ws-a', 'a2')"))
    assert await bodies(app_engine, ctx()) == ["a1", "a2"]


async def test_an_unscoped_connection_sees_nothing(app_engine: AsyncEngine) -> None:
    async with app_engine.connect() as conn:
        for table in (NOTES, LEDGER, LINKS):
            assert (await conn.execute(text(f"SELECT body FROM {table}"))).all() == []


async def test_a_pooled_connection_carries_no_context_into_the_next(
    app_engine: AsyncEngine,
) -> None:
    """The engine holds one connection, so the second checkout is the first's connection."""
    assert await bodies(app_engine, ctx("tenant-a", "ws-a", "ws-b")) == ["a1", "b1"]
    async with app_engine.connect() as conn:
        assert (await conn.execute(text(f"SELECT body FROM {NOTES}"))).all() == []
        tenant = await conn.scalar(text("SELECT current_setting('app.tenant_id', true)"))
    assert tenant in (None, "")


async def test_the_system_role_crosses_workspaces_but_not_tenants(
    app_engine: AsyncEngine,
) -> None:
    async with system_session(app_engine) as conn:
        assert (await conn.execute(text(f"SELECT body FROM {NOTES}"))).all() == []
    async with system_session(app_engine) as conn:
        await conn.execute(text("SELECT set_config('app.tenant_id', 'tenant-a', true)"))
        rows = sorted((await conn.execute(text(f"SELECT body FROM {NOTES}"))).scalars())
    assert rows == ["a1", "b1"]


async def test_a_tenant_scoped_table_is_read_across_workspaces_within_its_tenant(
    app_engine: AsyncEngine,
) -> None:
    assert await bodies(app_engine, ctx("tenant-a", "ws-z"), LEDGER) == ["a"]
    assert await bodies(app_engine, ctx("tenant-c", "ws-a"), LEDGER) == []


async def test_an_org_scoped_table_shows_one_org_and_fails_closed_to_other_shapes(
    app_engine: AsyncEngine,
) -> None:
    async with org_session(app_engine, "org-a") as conn:
        assert (await conn.execute(text(f"SELECT body FROM {LINKS}"))).scalars().all() == ["a"]
        assert (await conn.execute(text(f"SELECT body FROM {NOTES}"))).all() == []
    assert await bodies(app_engine, ctx(), LINKS) == []
