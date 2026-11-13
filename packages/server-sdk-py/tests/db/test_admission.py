"""Per-workspace admission: a burst from one workspace queues behind its own slots."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio
import pgbulkhead
import pytest
from sqlalchemy.exc import TimeoutError as PoolTimeout

from nimblebrain_server_sdk.db import (
    Overloaded,
    PoolExhausted,
    PoolSettings,
    SecurityContext,
    WorkspaceBusy,
    WorkspaceLimiter,
)
from nimblebrain_server_sdk.db.admission import admitted_session

A = SecurityContext(tenant_id="tenant-a", workspace_id="ws-a")
B = SecurityContext(tenant_id="tenant-a", workspace_id="ws-b")
# Same workspace id under another tenant: a different key.
OTHER_TENANT = SecurityContext(tenant_id="tenant-b", workspace_id="ws-a")


# The limiter exposes its state, not an event to wait on, so this polls it, bounded by the timeout.
async def _until(predicate, *, timeout: float = 5.0) -> None:  # noqa: ASYNC109
    with anyio.fail_after(timeout):
        while not predicate():  # noqa: ASYNC110
            await anyio.sleep(0.005)


async def test_workspace_at_its_cap_does_not_block_another_workspace() -> None:
    limiter = WorkspaceLimiter(limit=2, wait_seconds=30)
    release = anyio.Event()
    running = {"a": 0, "a_done": 0}

    async def hold_a() -> None:
        async with limiter.admit(A):
            running["a"] += 1
            await release.wait()
        running["a_done"] += 1

    async with anyio.create_task_group() as tg:
        for _ in range(5):
            tg.start_soon(hold_a)
        await _until(lambda: running["a"] == 2)
        await anyio.sleep(0.05)
        # A's extra calls wait for a slot rather than running or failing.
        assert running["a"] == 2

        with anyio.fail_after(1):
            async with limiter.admit(B), limiter.admit(OTHER_TENANT):
                assert limiter.tracked() == 3
        release.set()

    # Once released, every queued call for A ran too.
    assert running == {"a": 5, "a_done": 5}
    assert limiter.tracked() == 0


async def test_wait_past_the_bound_raises_workspace_busy() -> None:
    limiter = WorkspaceLimiter(limit=1, wait_seconds=0.05)
    async with limiter.admit(A):
        with pytest.raises(WorkspaceBusy) as caught:
            async with limiter.admit(A):
                pytest.fail("admitted past the cap")
    assert isinstance(caught.value, Overloaded)
    assert "Nothing was run" in caught.value.message
    assert caught.value.next_step
    assert limiter.tracked() == 0


async def test_last_call_leaving_drops_the_workspace_entry() -> None:
    limiter = WorkspaceLimiter(limit=2, wait_seconds=0.05)
    for n in range(50):
        async with limiter.admit(SecurityContext(tenant_id="t", workspace_id=f"ws-{n}")):
            assert limiter.tracked() == 1
    assert limiter.tracked() == 0

    with pytest.raises(WorkspaceBusy):
        async with limiter.admit(A), limiter.admit(A), limiter.admit(A):
            pass
    assert limiter.tracked() == 0


async def test_cancelled_waiter_and_holder_give_back_their_entry() -> None:
    limiter = WorkspaceLimiter(limit=1, wait_seconds=30)
    async with anyio.create_task_group() as tg:

        async def hold() -> None:
            async with limiter.admit(A):
                await anyio.sleep_forever()

        tg.start_soon(hold)
        tg.start_soon(hold)
        # One call holds the slot and the other waits for it.
        await _until(lambda: getattr(limiter._slots.get(("tenant-a", "ws-a")), "users", 0) == 2)
        tg.cancel_scope.cancel()
    assert limiter.tracked() == 0


def test_limiter_is_sized_from_the_pool_settings() -> None:
    limiter = WorkspaceLimiter.from_settings(
        PoolSettings(workspace_concurrency=3, workspace_wait_seconds=7)
    )
    assert (limiter.limit, limiter.wait_seconds) == (3, 7)
    with pytest.raises(ValueError, match="limit must be at least 1"):
        WorkspaceLimiter(limit=0, wait_seconds=1)


async def test_session_checkout_timeout_raises_pool_exhausted() -> None:
    limiter = WorkspaceLimiter(limit=1, wait_seconds=1)

    @asynccontextmanager
    async def exhausted(ctx: pgbulkhead.SecurityContext) -> AsyncIterator[str]:
        raise PoolTimeout("QueuePool limit reached")
        yield "unreachable"

    with pytest.raises(PoolExhausted) as caught:
        async with admitted_session(limiter, A, exhausted):
            pytest.fail("the body ran without a session")
    assert "QueuePool" not in str(caught.value)
    assert limiter.tracked() == 0


async def test_pool_timeout_inside_the_body_is_the_bodys_own() -> None:
    limiter = WorkspaceLimiter(limit=1, wait_seconds=1)

    @asynccontextmanager
    async def session(ctx: pgbulkhead.SecurityContext) -> AsyncIterator[str]:
        yield f"session for {ctx.workspace_id}"

    # The body raises inside the session, so the test covers how the session exits on it.
    with pytest.raises(PoolTimeout):  # noqa: PT012
        async with admitted_session(limiter, A, session) as conn:
            assert conn == "session for ws-a"
            raise PoolTimeout("a second checkout timed out")
    assert limiter.tracked() == 0
