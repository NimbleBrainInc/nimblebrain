"""The policy DDL a migration runs on asyncpg, which takes one statement per execute."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine

from nimblebrain_server_sdk.db import (
    rls_policy_sql,
    rls_policy_sql_org_scoped,
    rls_policy_sql_tenant_scoped,
    rls_policy_statements,
    rls_policy_statements_org_scoped,
    rls_policy_statements_tenant_scoped,
)

SHAPES: list[tuple[Callable[[str], str], Callable[[str], list[str]], str, set[str]]] = [
    (
        rls_policy_sql,
        rls_policy_statements,
        "tenant_id text, workspace_id text",
        {"select", "insert", "update", "delete"},
    ),
    (
        rls_policy_sql_tenant_scoped,
        rls_policy_statements_tenant_scoped,
        "tenant_id text, workspace_id text",
        set(),
    ),
    (rls_policy_sql_org_scoped, rls_policy_statements_org_scoped, "org_id text", set()),
]


@pytest.mark.parametrize(("as_sql", "as_statements", "_columns", "_policies"), SHAPES)
def test_the_statements_are_the_sql_split(
    as_sql: Callable[[str], str],
    as_statements: Callable[[str], list[str]],
    _columns: str,
    _policies: set[str],
) -> None:
    statements = as_statements("notes")
    assert len(statements) > 1
    assert all(s and s == s.strip() and ";" not in s for s in statements)
    normalized = [s.strip() for s in as_sql("notes").split(";") if s.strip()]
    assert statements == normalized


@pytest.mark.parametrize(("as_sql", "as_statements", "columns", "policies"), SHAPES)
async def test_a_migration_on_asyncpg_runs_the_statements(
    pg_admin: AsyncEngine,
    as_sql: Callable[[str], str],
    as_statements: Callable[[str], list[str]],
    columns: str,
    policies: set[str],
) -> None:
    table = f"rls_stmt_{len(as_statements('t'))}_{columns.count(',')}"
    async with pg_admin.begin() as conn:
        await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
        await conn.execute(text(f"CREATE TABLE {table} ({columns})"))
    try:
        # Why the list form exists: the one-string form is several commands, and asyncpg
        # refuses several in one execute.
        with pytest.raises(DBAPIError, match="multiple commands"):
            async with pg_admin.begin() as conn:
                await conn.execute(text(as_sql(table)))
        async with pg_admin.begin() as conn:
            for statement in as_statements(table):
                await conn.execute(text(statement))
            forced = await conn.scalar(
                text("SELECT relforcerowsecurity FROM pg_class WHERE relname = :t"), {"t": table}
            )
            names = set(
                await conn.scalars(
                    text("SELECT policyname FROM pg_policies WHERE tablename = :t"), {"t": table}
                )
            )
        assert forced is True
        assert names
        assert names >= {f"{table}_{command}" for command in policies}
    finally:
        async with pg_admin.begin() as conn:
            await conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
