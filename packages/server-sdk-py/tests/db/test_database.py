"""SecuredDatabase: one object per server owning its settings, engine and limiter."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import text
from sqlalchemy.exc import TimeoutError as PoolTimeout

from nimblebrain_server_sdk.db import (
    PoolConfigError,
    PoolExhausted,
    PoolSettings,
    SecuredDatabase,
    SecurityContext,
    WorkspaceBusy,
    WorkspaceLimiter,
)
from nimblebrain_server_sdk.db.testing import use_limiter

A = SecurityContext(tenant_id="tenant-a", workspace_id="ws-a")
B = SecurityContext(tenant_id="tenant-a", workspace_id="ws-b")


def test_importing_and_declaring_needs_no_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SVC_DATABASE_URL", raising=False)
    db = SecuredDatabase(url_env="SVC_DATABASE_URL", prefix="SVC")
    db.check()
    with pytest.raises(RuntimeError, match="SVC_DATABASE_URL"):
        db.get_engine()


def test_check_fails_on_settings_that_cannot_hold(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SVC_WORKSPACE_CONCURRENCY", "5")
    with pytest.raises(PoolConfigError):
        SecuredDatabase(url_env="SVC_DATABASE_URL", prefix="SVC").check()


def test_settings_are_read_once_with_the_servers_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    own = PoolSettings(pool_size=10, max_overflow=10, workspace_concurrency=4)
    db = SecuredDatabase(url_env="SVC_DATABASE_URL", prefix="SVC", defaults=own)
    db.check()
    monkeypatch.setenv("SVC_WORKSPACE_CONCURRENCY", "1")
    assert db.settings == own
    assert db.limiter.limit == 4


async def test_session_is_admitted_per_workspace(pg_url: str) -> None:
    db = SecuredDatabase(url_env="UNUSED", prefix="SVC", url=lambda: pg_url)
    try:
        with use_limiter(db, WorkspaceLimiter(limit=1, wait_seconds=0.05)) as limiter:
            async with db.session(A) as held:
                await held.execute(text("SELECT 1"))
                with pytest.raises(WorkspaceBusy):
                    async with db.session(A):
                        pytest.fail("admitted past the cap")
                async with db.session(B) as other:
                    assert (await other.execute(text("SELECT 1"))).scalar() == 1
            assert limiter.tracked() == 0
    finally:
        await db.dispose()


async def test_admitted_slot_holds_one_slot_across_sessions(pg_url: str) -> None:
    db = SecuredDatabase(url_env="UNUSED", prefix="SVC", url=lambda: pg_url)
    try:
        with use_limiter(db, WorkspaceLimiter(limit=1, wait_seconds=0.05)) as limiter:
            async with db.admitted(A) as slot:
                for _ in range(3):
                    async with slot.session() as conn:
                        await conn.execute(text("SELECT 1"))
                assert limiter.tracked() == 1
                with pytest.raises(WorkspaceBusy):
                    async with db.session(A):
                        pass
            assert limiter.tracked() == 0
    finally:
        await db.dispose()


async def test_admitted_slot_turns_a_checkout_timeout_into_pool_exhausted() -> None:
    @asynccontextmanager
    async def exhausted(ctx: SecurityContext) -> AsyncIterator[None]:
        raise PoolTimeout("QueuePool limit reached")
        yield

    db = SecuredDatabase(url_env="UNUSED", prefix="SVC")
    db.unadmitted_session = exhausted  # ty: ignore[invalid-assignment]
    async with db.admitted(A) as slot:
        with pytest.raises(PoolExhausted):
            async with slot.session():
                pytest.fail("the body ran without a session")


async def test_admitted_slot_lets_a_later_checkout_timeout_through() -> None:
    opened = 0

    @asynccontextmanager
    async def first_then_exhausted(ctx: SecurityContext) -> AsyncIterator[None]:
        nonlocal opened
        opened += 1
        if opened > 1:
            raise PoolTimeout("QueuePool limit reached")
        yield

    db = SecuredDatabase(url_env="UNUSED", prefix="SVC")
    db.unadmitted_session = first_then_exhausted  # ty: ignore[invalid-assignment]
    async with db.admitted(A) as slot:
        async with slot.session():
            pass
        with pytest.raises(PoolTimeout) as caught:
            async with slot.session():
                pytest.fail("the body ran without a session")
    assert not isinstance(caught.value, PoolExhausted)
