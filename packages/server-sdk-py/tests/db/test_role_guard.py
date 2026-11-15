"""A pooled engine refuses a role row-level security does not apply to — REAL Postgres.

Postgres applies no policy to a superuser or a ``BYPASSRLS`` role, so a server connected as one
would see every tenant's rows with no error. The pooled engine (``create_pooled_engine``, and so
every ``SecuredDatabase``) checks each new connection's role and refuses such a one with
``UnsafeRoleError`` before any session runs on it, unless the engine was built with
``refuse_bypass_roles=False`` for work that is meant to bypass, such as migrations.

A managed Postgres can exempt a role with neither attribute: on Amazon RDS a member of
``rds_superuser`` bypasses every policy. Stock Postgres has no such role, so the suite creates a
``rds_superuser`` (with nothing granted) and a login role that belongs to it, and shows the
default guard refuses that member through both entry points by its membership.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.pool import QueuePool

from nimblebrain_server_sdk.db import (
    MANAGED_ADMIN_ROLES,
    SecuredDatabase,
    SecurityContext,
    UnsafeRoleError,
    create_pooled_engine,
    secured_session,
)

from .conftest import _PASSWORD, APP_ROLE, BYPASS_ROLE, SMALL, _url_as

CTX = SecurityContext(tenant_id="tenant-a", workspace_id="ws-a")

_ROLE = "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"


def _checked_out(engine: AsyncEngine) -> int:
    pool = engine.pool
    assert isinstance(pool, QueuePool)
    return pool.checkedout()


@pytest.fixture
def privileged(request: pytest.FixtureRequest) -> tuple[str, str]:
    """The URL of a role RLS does not apply to, and the attribute the refusal names."""
    if request.param == "superuser":
        return request.getfixturevalue("pg_admin_url"), "a superuser"
    return request.getfixturevalue("pg_bypass_url"), "BYPASSRLS"


@pytest.mark.parametrize("privileged", ["superuser", "bypassrls"], indirect=True)
async def test_pooled_engine_refuses_a_privileged_role(privileged: tuple[str, str]) -> None:
    url, attribute = privileged
    engine = create_pooled_engine(url, SMALL)
    try:
        with pytest.raises(UnsafeRoleError, match=attribute):
            async with secured_session(engine, CTX):
                pytest.fail("a session ran as a role RLS does not apply to")
        # Every attempt is refused, not only the first, and none holds a connection.
        with pytest.raises(UnsafeRoleError):
            async with engine.connect():
                pytest.fail("a connection was handed out as a role RLS does not apply to")
        assert _checked_out(engine) == 0
    finally:
        await engine.dispose()


async def test_pooled_engine_admits_the_app_role(pg_engine: AsyncEngine) -> None:
    async with secured_session(pg_engine, CTX) as conn:
        role, superuser, bypassrls = (await conn.execute(text(_ROLE))).one()
    assert (role, superuser, bypassrls) == (APP_ROLE, False, False)


@pytest.mark.parametrize("privileged", ["superuser", "bypassrls"], indirect=True)
async def test_opting_out_admits_a_privileged_role(privileged: tuple[str, str]) -> None:
    url, _ = privileged
    engine = create_pooled_engine(url, SMALL, refuse_bypass_roles=False)
    try:
        async with engine.connect() as conn:
            _, superuser, bypassrls = (await conn.execute(text(_ROLE))).one()
        assert superuser or bypassrls
    finally:
        await engine.dispose()


async def test_secured_database_refuses_a_privileged_role(pg_bypass_url: str) -> None:
    db = SecuredDatabase(url_env="UNUSED", prefix="SVC", url=lambda: pg_bypass_url)
    try:
        with pytest.raises(UnsafeRoleError, match="BYPASSRLS"):
            await db.check_role()
        with pytest.raises(UnsafeRoleError):
            async with db.session(CTX):
                pytest.fail("a session ran as a role RLS does not apply to")
        with pytest.raises(UnsafeRoleError):
            async with db.system_session():
                pytest.fail("a system session ran as a role RLS does not apply to")
        assert db.limiter.tracked() == 0
    finally:
        await db.dispose()


async def test_secured_database_admits_the_app_role(pg_url: str) -> None:
    db = SecuredDatabase(url_env="UNUSED", prefix="SVC", url=lambda: pg_url)
    try:
        await db.check_role()
        async with db.session(CTX) as conn:
            assert (await conn.execute(text("SELECT current_user"))).scalar() == APP_ROLE
    finally:
        await db.dispose()


async def test_secured_database_opting_out_admits_a_privileged_role(pg_bypass_url: str) -> None:
    db = SecuredDatabase(
        url_env="UNUSED", prefix="SVC", url=lambda: pg_bypass_url, refuse_bypass_roles=False
    )
    try:
        async with db.system_session() as conn:
            assert (await conn.execute(text("SELECT current_user"))).scalar() == BYPASS_ROLE
    finally:
        await db.dispose()


#: A login role with neither attribute that belongs to the stand-in ``rds_superuser``.
ADMIN_MEMBER = "sdk_rds_admin_member"


@pytest_asyncio.fixture
async def pg_admin_member_url(pg_admin: AsyncEngine) -> str:
    assert "rds_superuser" in MANAGED_ADMIN_ROLES
    async with pg_admin.begin() as conn:
        for role, attributes in (
            ("rds_superuser", "NOLOGIN"),
            (ADMIN_MEMBER, f"LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '{_PASSWORD}'"),
        ):
            exists = await conn.scalar(
                text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}
            )
            if not exists:
                await conn.execute(text(f"CREATE ROLE {role} {attributes}"))
        await conn.execute(text(f"GRANT rds_superuser TO {ADMIN_MEMBER}"))
    return _url_as(ADMIN_MEMBER)


async def test_pooled_engine_refuses_a_member_of_a_managed_admin_role(
    pg_admin_member_url: str,
) -> None:
    engine = create_pooled_engine(pg_admin_member_url, SMALL)
    try:
        with pytest.raises(UnsafeRoleError, match="member of 'rds_superuser'"):
            async with secured_session(engine, CTX):
                pytest.fail("a session ran as a member of a managed admin role")
        assert _checked_out(engine) == 0
    finally:
        await engine.dispose()


async def test_secured_database_refuses_a_member_of_a_managed_admin_role(
    pg_admin_member_url: str,
) -> None:
    db = SecuredDatabase(url_env="UNUSED", prefix="SVC", url=lambda: pg_admin_member_url)
    try:
        with pytest.raises(UnsafeRoleError, match="member of 'rds_superuser'"):
            await db.check_role()
        with pytest.raises(UnsafeRoleError):
            async with db.session(CTX):
                pytest.fail("a session ran as a member of a managed admin role")
        with pytest.raises(UnsafeRoleError):
            async with db.system_session():
                pytest.fail("a system session ran as a member of a managed admin role")
    finally:
        await db.dispose()


async def test_the_guard_leaves_the_app_roles_connection_clean(pg_engine: AsyncEngine) -> None:
    """The probe's table is gone before the connection is handed out."""
    async with pg_engine.connect() as conn:
        probe = await conn.scalar(text("SELECT to_regclass('pg_temp.pgbulkhead_rls_probe')"))
    assert probe is None


@pytest.fixture
def attributes_unseen(monkeypatch: pytest.MonkeyPatch) -> None:
    """Blind pgbulkhead's attribute and membership checks, so only its probe can refuse: the
    closest stock Postgres comes to a role that bypasses with neither attribute."""
    import pgbulkhead.role

    monkeypatch.setattr(pgbulkhead.role, "_reasons", lambda *_: [])


async def test_the_probe_alone_refuses_a_bypassing_session_through_both_entry_points(
    pg_bypass_url: str, attributes_unseen: None
) -> None:
    engine = create_pooled_engine(pg_bypass_url, SMALL)
    db = SecuredDatabase(url_env="UNUSED", prefix="SVC", url=lambda: pg_bypass_url)
    try:
        with pytest.raises(UnsafeRoleError, match="forced policy"):
            async with secured_session(engine, CTX):
                pytest.fail("a session ran on a connection that bypasses RLS")
        with pytest.raises(UnsafeRoleError, match="forced policy"):
            await db.check_role()
    finally:
        await engine.dispose()
        await db.dispose()
