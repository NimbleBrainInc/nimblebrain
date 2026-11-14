"""The outbox against a real Postgres: what a poll returns, and what it never skips."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from nimblebrain_server_sdk.db import SecurityContext, secured_session
from nimblebrain_server_sdk.outbox import RETENTION, core, emit, read
from nimblebrain_server_sdk.outbox.cursor import Cursor
from tests.outbox.conftest import TABLE, session


def envelope(event_id: str, name: str = "domain.active", **overrides: Any) -> dict[str, Any]:
    base = {
        "eventId": event_id,
        "name": name,
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {"id": event_id},
    }
    return base | overrides


async def emit_one(engine: AsyncEngine, ctx: SecurityContext, event_id: str, **kw: Any) -> int:
    """One emit in its own transaction, so each takes its own transaction id."""
    async with session(engine, ctx) as conn:
        seq = await emit(conn, ctx, envelope(event_id), **kw)
    assert seq is not None
    return seq


async def poll(
    engine: AsyncEngine, ctx: SecurityContext, cursor: str | None = None, **kw: Any
) -> dict[str, Any]:
    async with session(engine, ctx) as conn:
        return await read(conn, ctx, cursor=cursor, **kw)


def ids(result: dict[str, Any]) -> list[str]:
    return [event["eventId"] for event in result["events"]]


# --------------------------------------------------------------------------- #
# The round trip.                                                              #
# --------------------------------------------------------------------------- #


async def test_bootstrap_returns_a_cursor_and_no_history(engine, ctx) -> None:
    """A newly installed connector must not open with a backlog nobody asked for."""
    async with session(engine, ctx) as conn:
        await emit(conn, ctx, envelope("evt_before"))

    result = await poll(engine, ctx)
    assert result["events"] == []
    assert result["truncated"] is False
    assert result["hasMore"] is False
    assert result["cursor"]
    assert "nextPollMs" not in result


async def test_emit_then_read_returns_the_whole_envelope(engine, ctx) -> None:
    start = await poll(engine, ctx)
    async with session(engine, ctx) as conn:
        await emit(
            conn,
            ctx,
            envelope("evt_1"),
            title="acme-outreach.example is active",
            level="attention",
            subject="acme-outreach.example",
            body="DNS propagated.",
            link_resource="acme://domains/dom_1",
        )

    result = await poll(engine, ctx, start["cursor"])
    (event,) = result["events"]
    assert event["eventId"] == "evt_1"
    assert event["name"] == "domain.active"
    assert event["data"] == {"id": "evt_1"}
    assert event["timestamp"].endswith("Z")
    assert event["cursor"]
    presentation = event["_meta"]["ai.nimblebrain/notification"]
    assert presentation["level"] == "attention"
    assert presentation["title"] == "acme-outreach.example is active"
    assert presentation["link"] == {"resource": "acme://domains/dom_1"}


async def test_an_envelope_with_no_presentation_block_carries_none(engine, ctx) -> None:
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_bare")
    (event,) = (await poll(engine, ctx, start["cursor"]))["events"]
    assert "_meta" not in event


async def test_a_repeated_event_id_is_a_no_op(engine, ctx) -> None:
    """At-least-once upstream must not become duplicates downstream."""
    start = await poll(engine, ctx)
    async with session(engine, ctx) as conn:
        assert await emit(conn, ctx, envelope("evt_dupe")) is not None
        assert await emit(conn, ctx, envelope("evt_dupe", name="other.name")) is None

    assert ids(await poll(engine, ctx, start["cursor"])) == ["evt_dupe"]


async def test_reading_again_with_the_returned_cursor_returns_nothing(engine, ctx) -> None:
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_1")
    first = await poll(engine, ctx, start["cursor"])
    assert ids(first) == ["evt_1"]
    assert ids(await poll(engine, ctx, first["cursor"])) == []


# --------------------------------------------------------------------------- #
# The commit-order gap — the property the library exists for.                  #
# --------------------------------------------------------------------------- #


async def test_a_poll_never_skips_a_row_that_was_in_flight(engine, ctx) -> None:
    """A takes the earlier transaction id; B takes the later one and commits first.

    A cursor that advanced on commit order would move past B while A was still
    open, and A's row would be behind it forever. The horizon holds the cursor
    at A instead, so B waits one poll and both arrive in order on the next.
    """
    start = await poll(engine, ctx)

    held = secured_session(engine, ctx)
    conn_a = await held.__aenter__()
    try:
        await emit(conn_a, ctx, envelope("evt_a"))  # earlier txid, still open

        async with session(engine, ctx) as conn_b:
            await emit(conn_b, ctx, envelope("evt_b"))  # later txid, committed first

        blocked = await poll(engine, ctx, start["cursor"])
        assert blocked["events"] == [], "B was returned past an in-flight A"
    finally:
        await held.__aexit__(None, None, None)  # A commits

    caught_up = await poll(engine, ctx, blocked["cursor"])
    assert ids(caught_up) == ["evt_a", "evt_b"]


async def test_an_emit_in_the_answering_transaction_is_returned_by_it(engine, ctx) -> None:
    """The read is the server's tick: refresh, record, and answer in one transaction.

    Those rows are above the horizon and visible to that transaction alone, so
    they are delivered eagerly — and the cursor records how far, so the next
    poll does not hand them over a second time.
    """
    start = await poll(engine, ctx)
    async with session(engine, ctx) as conn:
        await emit(conn, ctx, envelope("evt_tick"))
        same_transaction = await read(conn, ctx, cursor=start["cursor"])

    assert ids(same_transaction) == ["evt_tick"]
    assert ids(await poll(engine, ctx, same_transaction["cursor"])) == []


# --------------------------------------------------------------------------- #
# Paging, replay bounds, and truncation.                                       #
# --------------------------------------------------------------------------- #


async def test_a_batch_cut_at_the_cap_says_so_and_resumes(engine, ctx) -> None:
    start = await poll(engine, ctx)
    for index in range(3):
        await emit_one(engine, ctx, f"evt_{index}")

    first = await poll(engine, ctx, start["cursor"], max_events=2)
    assert ids(first) == ["evt_0", "evt_1"]
    assert first["hasMore"] is True

    second = await poll(engine, ctx, first["cursor"], max_events=2)
    assert ids(second) == ["evt_2"]
    assert second["hasMore"] is False


async def test_max_events_is_held_to_the_hard_ceiling(engine, ctx) -> None:
    result = await poll(engine, ctx, max_events=100_000)
    assert result["events"] == []  # bootstrap; the point is that it did not raise


async def test_a_per_event_cursor_resumes_after_that_event(engine, ctx) -> None:
    start = await poll(engine, ctx)
    for index in range(3):
        await emit_one(engine, ctx, f"evt_{index}")

    everything = await poll(engine, ctx, start["cursor"])
    assert ids(everything) == ["evt_0", "evt_1", "evt_2"]
    resumed = await poll(engine, ctx, everything["events"][0]["cursor"])
    assert ids(resumed) == ["evt_1", "evt_2"]


async def test_max_age_ms_bounds_replay_and_reports_what_it_hid(engine, ctx) -> None:
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_old")
    await emit_one(engine, ctx, "evt_new")
    await backdate(engine, ctx, "evt_old", created_at=timedelta(hours=1))

    bounded = await poll(engine, ctx, start["cursor"], max_age_ms=60_000)
    assert ids(bounded) == ["evt_new"]
    assert bounded["truncated"] is True, "events after the cursor were skipped in silence"


async def test_max_age_ms_hiding_nothing_is_not_truncation(engine, ctx) -> None:
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_1")
    bounded = await poll(engine, ctx, start["cursor"], max_age_ms=3_600_000)
    assert ids(bounded) == ["evt_1"]
    assert bounded["truncated"] is False


async def test_the_row_cap_drops_the_oldest_and_a_later_poll_is_told(engine, ctx) -> None:
    """An outbox nobody polls cannot grow without bound, and the loss is visible."""
    start = await poll(engine, ctx)
    for index in range(5):
        await emit_one(engine, ctx, f"evt_{index}", max_rows=3)

    behind = await poll(engine, ctx, start["cursor"])
    assert ids(behind) == ["evt_2", "evt_3", "evt_4"]
    assert behind["truncated"] is True


async def test_a_reader_that_kept_up_is_not_told_it_was_truncated(engine, ctx) -> None:
    """The cap only truncates a cursor it dropped rows from at or above."""
    start = await poll(engine, ctx)
    for index in range(3):
        await emit_one(engine, ctx, f"evt_{index}", max_rows=3)
    caught_up = await poll(engine, ctx, start["cursor"])
    assert ids(caught_up) == ["evt_0", "evt_1", "evt_2"]

    await emit_one(engine, ctx, "evt_3", max_rows=3)  # drops evt_0, already delivered
    following = await poll(engine, ctx, caught_up["cursor"])
    assert ids(following) == ["evt_3"]
    assert following["truncated"] is False


async def test_a_cursor_from_another_epoch_replays_what_is_retained(engine, ctx) -> None:
    await emit_one(engine, ctx, "evt_1")
    foreign = Cursor("00000000-0000-0000-0000-000000000000", 1).encode()
    result = await poll(engine, ctx, foreign)
    assert ids(result) == ["evt_1"]
    assert result["truncated"] is True


async def test_a_cursor_ahead_of_the_database_replays_what_is_retained(engine, ctx) -> None:
    """What a restored database looks like: the rows survive, the counter rewinds."""
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_1")
    from_the_future = Cursor(_epoch_of(start["cursor"]), 2**62).encode()

    result = await poll(engine, ctx, from_the_future)
    assert ids(result) == ["evt_1"]
    assert result["truncated"] is True


async def test_an_unreadable_cursor_replays_rather_than_failing(engine, ctx) -> None:
    await emit_one(engine, ctx, "evt_1")
    result = await poll(engine, ctx, "not-a-cursor-this-outbox-issued")
    assert ids(result) == ["evt_1"]
    assert result["truncated"] is True


# --------------------------------------------------------------------------- #
# Retention.                                                                   #
# --------------------------------------------------------------------------- #


async def test_a_read_prunes_what_it_delivered_seven_days_ago(engine, ctx) -> None:
    """No sweeper, no CronJob, no system session — retention rides the poll."""
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_old")
    assert ids(await poll(engine, ctx, start["cursor"])) == ["evt_old"]

    await age_stamp(engine, ctx, "evt_old", RETENTION + timedelta(days=1))
    await poll(engine, ctx, start["cursor"])
    assert await surviving(engine, ctx) == []


async def test_a_row_still_owed_to_a_reader_is_never_pruned(engine, ctx) -> None:
    """Retention is not a timeout. A workspace whose poll has been down for months
    still gets what it never received — age alone deletes nothing."""
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_unread")
    await backdate(engine, ctx, "evt_unread", created_at=timedelta(days=90))

    # A cursored poll that has not yet reached it: still owed, so still here.
    await poll(engine, ctx, start["cursor"], max_age_ms=1)
    assert await surviving(engine, ctx) == ["evt_unread"]
    assert await stamped_at(engine, ctx, "evt_unread") is None


# --------------------------------------------------------------------------- #
# The optional extras.                                                         #
# --------------------------------------------------------------------------- #


async def test_next_poll_ms_is_carried_when_the_caller_supplies_one(engine, ctx) -> None:
    async with session(engine, ctx) as conn:
        result = await read(conn, ctx, next_poll_ms=15_000)
    assert result["nextPollMs"] == 15_000


async def test_an_explicit_table_is_honoured(engine, ctx) -> None:
    """Adopters that renamed the table pass their own; the default path is the rest."""
    start = await poll(engine, ctx)
    async with session(engine, ctx) as conn:
        await emit(conn, ctx, envelope("evt_1"), table=TABLE)
        result = await read(conn, ctx, cursor=start["cursor"], table=TABLE)
    assert ids(result) == ["evt_1"]


async def test_a_row_cap_below_one_is_a_programming_error(engine, ctx) -> None:
    async with session(engine, ctx) as conn:
        with pytest.raises(ValueError, match="max_rows"):
            await emit(conn, ctx, envelope("evt_1"), max_rows=0)


# --------------------------------------------------------------------------- #
# Helpers that reach past the library, to set up what time cannot.             #
# --------------------------------------------------------------------------- #


async def backdate(
    engine: AsyncEngine,
    ctx: SecurityContext,
    event_id: str,
    *,
    created_at: timedelta,
) -> None:
    """Age one row's creation, since the suite cannot wait seven days for the prune.

    Deliberately cannot set ``first_read_at``: retention is driven by that column, so a
    helper that supplied it would let a test pass whether or not the code under test ever
    wrote one. :func:`age_stamp` shifts a stamp that already exists, which is the form a
    retention assertion needs.
    """
    async with session(engine, ctx) as conn:
        await conn.execute(
            TABLE.update()
            .where(TABLE.c.event_id == event_id)
            .values(created_at=sa.func.now() - created_at)
        )


async def age_stamp(
    engine: AsyncEngine, ctx: SecurityContext, event_id: str, by: timedelta
) -> None:
    """Move an EXISTING ``first_read_at`` back, and do nothing to a null one.

    Deliberately not :func:`backdate`, which sets the column. A retention test that set
    the stamp itself would pass whether or not the code under test ever wrote one — which
    is exactly the bug in question.
    """
    async with session(engine, ctx) as conn:
        await conn.execute(
            TABLE.update()
            .where(TABLE.c.event_id == event_id, TABLE.c.first_read_at.is_not(None))
            .values(first_read_at=TABLE.c.first_read_at - by)
        )


async def surviving(engine: AsyncEngine, ctx: SecurityContext) -> list[str]:
    async with session(engine, ctx) as conn:
        rows = await conn.execute(sa.select(TABLE.c.event_id).order_by(TABLE.c.seq))
    return [row.event_id for row in rows]


def _epoch_of(cursor: str) -> str:
    """The epoch inside a cursor this outbox issued, for building a hostile one."""
    import base64
    import json

    body = cursor.removeprefix("nbo1:")
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))[0]


# --------------------------------------------------------------------------- #
# Bounds on what a caller may put into a poll.                                 #
# --------------------------------------------------------------------------- #


async def test_an_absurd_max_age_is_clamped_rather_than_raised(engine, ctx) -> None:
    """A window wider than a timedelta can hold excludes nothing, so it is not a failure.

    The value comes off a query string. A caller's typo must not be the thing
    that stops a workspace being polled.
    """
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_1")
    result = await poll(engine, ctx, start["cursor"], max_age_ms=10**20)
    assert ids(result) == ["evt_1"]
    assert result["truncated"] is False


async def test_a_negative_max_age_is_floored_rather_than_raised(engine, ctx) -> None:
    """The other end of the same constructor: a large negative overflows it too.

    Floored at zero the window is empty rather than backwards, so the answer is
    the honest one — no events, and ``truncated`` saying so.
    """
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_1")
    result = await poll(engine, ctx, start["cursor"], max_age_ms=-(10**20))
    assert ids(result) == []
    assert result["truncated"] is True


async def test_a_cursor_position_outside_bigint_is_refused_not_bound(engine, ctx) -> None:
    """It would reach the query as an out-of-range bind, which is a driver error
    where a cursor this outbox cannot honour is an ordinary truncated answer."""
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_1")
    forged = Cursor(_epoch_of(start["cursor"]), 1, 2**70, 1).encode()

    result = await poll(engine, ctx, forged)
    assert ids(result) == ["evt_1"]
    assert result["truncated"] is True


# --------------------------------------------------------------------------- #
# Two promises the rest of the suite leans on without pinning.                 #
# --------------------------------------------------------------------------- #


async def test_the_row_cap_crossed_mid_read_is_still_reported(engine, ctx, monkeypatch) -> None:
    """The loss watermark is read AFTER the rows, so a drop that lands inside a
    read cannot be missed by it.

    What this pins is that the watermark is read after the horizon — the seam it
    has is the ``_snapshot`` patch below. The one-statement window between the
    row select and the watermark is narrower than any seam this suite owns, so
    the comment at the read site is what holds that half.

    Both statements take their own snapshot, so reading the watermark first left
    a window in which the select saw rows as gone and the truncation test saw a
    watermark from before they were dropped — and the poll then reported a
    complete stream it did not have, for good: the next poll's watermark sits
    above the dropped ids.
    """
    start = await poll(engine, ctx)
    for index in range(3):
        await emit_one(engine, ctx, f"evt_{index}", max_rows=3)

    original = core._snapshot
    crossed = False

    async def cross_the_cap_mid_read(conn: AsyncConnection) -> Any:
        nonlocal crossed
        result = await original(conn)
        if not crossed:
            crossed = True
            for index in (3, 4):
                await emit_one(engine, ctx, f"evt_{index}", max_rows=3)
        return result

    monkeypatch.setattr(core, "_snapshot", cross_the_cap_mid_read)
    async with session(engine, ctx) as conn:
        raced = await read(conn, ctx, cursor=start["cursor"])

    assert ids(raced) == ["evt_2"], "setup: evt_0 and evt_1 should have been dropped"
    assert raced["truncated"] is True, "two undelivered events were dropped in silence"


async def test_a_replay_does_not_restart_the_retention_clock(engine, ctx) -> None:
    """`first_read_at` is stamped once. If a replay reset it — and a truncated
    cursor replays — a row polled repeatedly would never reach the prune."""
    start = await poll(engine, ctx)
    await emit_one(engine, ctx, "evt_1")
    await poll(engine, ctx, start["cursor"])
    first = await stamped_at(engine, ctx, "evt_1")

    await poll(engine, ctx, start["cursor"])  # the same cursor again
    assert await stamped_at(engine, ctx, "evt_1") == first


async def test_emit_takes_no_savepoint_of_its_own(engine, ctx) -> None:
    """So a state change rolled back to a savepoint takes its event with it.

    The first emitter depends on exactly this: it claims domains one savepoint
    at a time, and a claim that fails must not leave an event saying it landed.
    """
    async with session(engine, ctx) as conn:
        await emit(conn, ctx, envelope("evt_kept"))
        savepoint = await conn.begin_nested()
        await emit(conn, ctx, envelope("evt_rolled_back"))
        await savepoint.rollback()

    assert await surviving(engine, ctx) == ["evt_kept"]


async def stamped_at(engine: AsyncEngine, ctx: SecurityContext, event_id: str) -> Any:
    async with session(engine, ctx) as conn:
        return await conn.scalar(
            sa.select(TABLE.c.first_read_at).where(TABLE.c.event_id == event_id)
        )


# --------------------------------------------------------------------------- #
# What a bootstrap does to the rows it steps over.                             #
#                                                                              #
# A read with no cursor answers with no history and a cursor at the horizon, so #
# every existing row is permanently behind the reader. Nothing else in the      #
# module can resolve that state: retention keys on `first_read_at`, and `emit`  #
# will not reuse an `event_id` while the row holding it exists.                 #
# --------------------------------------------------------------------------- #


async def test_a_bootstrap_stamps_the_rows_it_steps_over(engine, ctx) -> None:
    await emit_one(engine, ctx, "evt_before")
    assert await stamped_at(engine, ctx, "evt_before") is None

    await poll(engine, ctx)

    assert await stamped_at(engine, ctx, "evt_before") is not None, (
        "a row the bootstrap put behind its cursor is decided, and must start its clock"
    )


async def test_a_bootstrap_skipped_row_prunes_on_the_same_seven_days(engine, ctx) -> None:
    """The defect this exists for: unstamped, the row is immortal — `_prune` keys on
    `first_read_at`, so a row that is never returned is never eligible."""
    await emit_one(engine, ctx, "evt_before")
    await poll(engine, ctx)

    await age_stamp(engine, ctx, "evt_before", RETENTION + timedelta(days=1))
    await poll(engine, ctx)

    assert await surviving(engine, ctx) == []


async def test_a_bootstrap_skipped_event_id_can_be_emitted_again_once_it_ages_out(
    engine, ctx
) -> None:
    """The consequence that bites hardest, end to end.

    `emit` is ON CONFLICT DO NOTHING over `(workspace_id, event_id)`, and a server that
    derives its id from a stable key — a domain transition keyed on the provider's id —
    re-emits that same id when the fact recurs. While the skipped row sits there the
    re-emit is silently a no-op, so the workspace is never told. Observed on staging: a
    domain went pending -> active, the row moved, and nothing reached the inbox.
    """
    await emit_one(engine, ctx, "domain.active:acme")
    start = await poll(engine, ctx)  # bootstrap: steps over it

    # While the row is retained the id is still held, which is the same dedupe a
    # delivered row gives and is wanted.
    async with session(engine, ctx) as conn:
        assert await emit(conn, ctx, envelope("domain.active:acme")) is None

    await age_stamp(engine, ctx, "domain.active:acme", RETENTION + timedelta(days=1))
    await poll(engine, ctx, start["cursor"])
    assert await surviving(engine, ctx) == []

    # Aged out, so the fact can be announced again.
    await emit_one(engine, ctx, "domain.active:acme")
    assert ids(await poll(engine, ctx, start["cursor"])) == ["domain.active:acme"]


async def test_a_bootstrap_does_not_stamp_what_it_still_owes(engine, ctx) -> None:
    """Only rows the cursor actually passed. A row written by the answering transaction
    is at or above the horizon, so the NEXT poll owes it — stamping it here would drop
    it on the floor, which is the same bug one transaction over."""
    async with session(engine, ctx) as conn:
        await emit(conn, ctx, envelope("evt_same_txn"))
        result = await read(conn, ctx, cursor=None)

    assert result["events"] == []
    assert await stamped_at(engine, ctx, "evt_same_txn") is None
    assert ids(await poll(engine, ctx, result["cursor"])) == ["evt_same_txn"]
