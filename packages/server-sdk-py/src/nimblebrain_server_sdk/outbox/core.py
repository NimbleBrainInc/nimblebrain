"""The outbox: the table, its DDL, and the two operations over it.

A server that has something to say appends an envelope here, inside the
transaction that made the fact true, and answers one poll from it. It never
calls a host, never learns a host's address, and stores nothing about one.

The one correctness property this exists to carry
------------------------------------------------

**A poll never skips a row that was in flight when it ran.**

A sequence number cannot give that. Transaction A takes ``seq = 10``,
transaction B takes ``11`` and commits first; a poll ordered by ``seq`` returns
through 11 and moves its cursor there; A commits; row 10 is now behind the
cursor and no reader will ever ask for it again. Nothing downstream can
recover it, because no dedupe key can name a row nobody read.

So the cursor is not a position in the sequence — it is a **snapshot horizon**.
Every row records the id of the transaction that wrote it
(``pg_current_xact_id()``), the poll returns only rows whose transaction id is
below ``pg_snapshot_xmin(pg_current_snapshot())`` — the oldest transaction
still running, and therefore the point below which every transaction has
finished — and the cursor advances no further than that. In the case above the
horizon sits at A, so B is held back for one poll and both surface in order on
the next. The cost is one poll of latency for a row that raced; the thing
bought is that there is no such thing as a row that was passed over.

Two details of that, since both are easy to get subtly wrong:

  * The transaction id is stored in a **column**, not read from the ``xmin``
    system column. ``xmin`` is a 32-bit wrapping ``xid`` with no ordering
    against the 64-bit ``xid8`` the horizon function returns, and it cannot be
    indexed. ``pg_current_xact_id()::text::bigint`` is the same number in a
    form that compares and indexes.
  * A server may emit **inside the transaction that answers the poll** — the
    read is its tick (it refreshes something upstream, sees a change, records
    it, and returns it in the same response). Those rows are above the horizon
    and visible to that transaction alone, so they are delivered eagerly and
    the cursor records how far, rather than being held for a poll that would
    defeat the point.

Retention has no sweeper
------------------------

Nothing here runs on a timer, and nothing runs as ``system``. A read stamps
``first_read_at`` on every row it *decided* — the ones it returned, and, on a
bootstrap, the ones it put permanently behind its own cursor — and deletes what
has carried one for seven days, in the same transaction, under the caller's RLS.
An outbox nobody polls therefore never prunes, which is why :func:`emit` also
enforces a per-workspace row cap, and why crossing it is the one thing that
makes a later poll report ``truncated``.

The stamp covers a skip as well as a delivery because it is the only thing that
starts the clock, and a row nothing ever starts a clock on is immortal — and
holds its ``event_id`` against :func:`emit`'s conflict clause forever with it.
See :func:`_stamp_skipped`.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncConnection
from sqlalchemy.schema import CreateIndex, CreateTable

from nimblebrain_server_sdk.db import SecurityContext, rls_policy_sql

from . import metrics
from .cursor import Cursor, CursorError
from .cursor import decode as decode_cursor
from .envelope import validate

__all__ = [
    "DEFAULT_MAX_EVENTS",
    "DEFAULT_MAX_ROWS",
    "DEFAULT_TABLE_NAME",
    "MAX_AGE_MS_CEILING",
    "MAX_MAX_EVENTS",
    "RETENTION",
    "emit",
    "outbox_ddl",
    "outbox_table",
    "read",
]

#: The table name an adopter gets unless it asks for another.
DEFAULT_TABLE_NAME = "notification_outbox"

#: Events per poll when the caller expresses no preference, and the ceiling it
#: is held to whatever it asks for. The host has its own budget; this is the
#: server refusing to be asked for an unbounded page.
DEFAULT_MAX_EVENTS = 100
MAX_MAX_EVENTS = 500

#: Rows one workspace's outbox may hold. Past it, :func:`emit` drops the oldest
#: in the order a poll would have read them, so the loss is always a prefix and
#: a cursor can be told it fell behind one.
DEFAULT_MAX_ROWS = 10_000

#: How long a row survives the poll that first returned it.
RETENTION = timedelta(days=7)

#: Largest ``max_age_ms`` worth honouring, in milliseconds — a century, which
#: reaches past any row this table can hold, so clamping to it excludes nothing
#: a wider window would have returned. It exists because ``timedelta`` raises
#: ``OverflowError`` past a C int of milliseconds, and the value comes off a
#: query string: a caller's typo must not be the thing that stops a workspace
#: being polled. The floor is zero, for the same reason in the other direction —
#: a large negative overflows the same constructor, and a window that ends
#: before it starts is not one this outbox can answer.
MAX_AGE_MS_CEILING = 100 * 365 * 24 * 60 * 60 * 1000


def outbox_table(sa_metadata: sa.MetaData, name: str = DEFAULT_TABLE_NAME) -> sa.Table:
    """Define the outbox on ``sa_metadata`` and return it.

    A companion ``<name>_state`` table is defined alongside, holding the two
    per-workspace facts that are not events: the outbox **epoch**, which makes a
    cursor from before a database restore detectable rather than silently
    unmatchable, and how far the row cap has dropped, which is the only honest
    source for ``truncated``. Both carry ``(tenant_id, workspace_id)`` and take
    the same RLS policy as the outbox itself.
    """
    table = sa.Table(
        name,
        sa_metadata,
        sa.Column("seq", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text, nullable=False),
        sa.Column("workspace_id", sa.Text, nullable=False),
        sa.Column("event_id", sa.Text, nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("data", postgresql.JSONB, nullable=False),
        sa.Column("meta", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        # The writing transaction's id, as a bigint (see the module docstring
        # for why not `xmin`). Written by the database, never by the caller.
        sa.Column(
            "txid",
            sa.BigInteger,
            nullable=False,
            server_default=sa.text("(pg_current_xact_id()::text::bigint)"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("first_read_at", sa.DateTime(timezone=True), nullable=True),
        # The idempotency key. A server that retries an emit writes the same
        # eventId and the second write is a no-op, so at-least-once upstream
        # does not become duplicates downstream.
        sa.UniqueConstraint("workspace_id", "event_id", name=f"{name}_workspace_event_key"),
        # The poll: one workspace, transaction ids from the cursor up, in read
        # order. Also serves the row cap, which trims in that same order.
        sa.Index(f"{name}_poll_idx", "workspace_id", "txid", "seq"),
        # Retention: the rows a read has already returned, oldest first.
        sa.Index(f"{name}_retention_idx", "workspace_id", "first_read_at"),
    )
    sa.Table(
        f"{name}_state",
        sa_metadata,
        sa.Column("tenant_id", sa.Text, nullable=False),
        sa.Column("workspace_id", sa.Text, nullable=False),
        sa.Column(
            "epoch",
            postgresql.UUID(as_uuid=False),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "dropped_through_txid",
            sa.BigInteger,
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("tenant_id", "workspace_id"),
    )
    return table


def outbox_ddl(table: sa.Table) -> list[str]:
    """The outbox's DDL — both tables, their indexes, and the RLS policy.

    For an alembic revision, beside the adopter's other tables::

        for statement in outbox_ddl(outbox_table(MetaData())):
            op.execute(statement)

    **One statement per item, and never a semicolon inside one.** asyncpg
    refuses multiple commands in a single execute, so a library that handed
    back one blob of SQL would make every adopter rediscover that and write its
    own splitter — which each of them has. The loop is the whole difference.

    Rendered from the same :class:`~sqlalchemy.Table` the queries are built
    against, so a migration and a read cannot describe different columns.
    """
    statements: list[str] = []
    for target in (table, _state_table(table)):
        statements.append(_compile(CreateTable(target)))
        statements.extend(
            _compile(CreateIndex(index))
            for index in sorted(target.indexes, key=lambda index: index.name or "")
        )
        statements.extend(
            statement.strip()
            for statement in rls_policy_sql(target.name).split(";")
            if statement.strip()
        )
    return statements


async def emit(
    conn: AsyncConnection,
    ctx: SecurityContext,
    envelope: dict[str, Any],
    *,
    title: str | None = None,
    level: str | None = None,
    subject: str | None = None,
    body: str | None = None,
    link_resource: str | None = None,
    max_rows: int = DEFAULT_MAX_ROWS,
    table: sa.Table | None = None,
) -> int | None:
    """Append one envelope, in the caller's transaction. Returns its ``seq``.

    Opens no transaction and takes no savepoint of its own: the append belongs
    to the write that made the fact true, so a rolled-back state change takes
    its event with it and a committed one cannot lose it. Returns ``None`` when
    ``eventId`` is already in this workspace's outbox — a re-emit is a no-op,
    not an error.

    ``tenant_id`` and ``workspace_id`` are stamped from ``ctx``, never from the
    envelope, so the row is checked against the session's identity by the INSERT
    policy's ``WITH CHECK`` rather than by anything here.

    Pass the presentation fields as keywords (``title=``, ``level=``,
    ``subject=``, ``body=``, ``link_resource=``) and the
    ``_meta["ai.nimblebrain/notification"]`` block is built for you, so no
    adopter types the reverse-DNS key. An envelope with no such block is still
    a notification, rendered from ``name``.
    """
    tbl = table if table is not None else _default_outbox()
    checked = validate(
        envelope,
        title=title,
        level=level,
        subject=subject,
        body=body,
        link_resource=link_resource,
    )

    insert = (
        postgresql.insert(tbl)
        .values(
            tenant_id=ctx.tenant_id,
            workspace_id=ctx.workspace_id,
            event_id=checked.event_id,
            name=checked.name,
            timestamp=checked.timestamp,
            data=checked.data,
            meta=checked.meta,
        )
        .on_conflict_do_nothing(index_elements=["workspace_id", "event_id"])
        .returning(tbl.c.seq)
    )
    seq = (await conn.execute(insert)).scalar_one_or_none()
    if seq is None:
        return None

    metrics.EMITTED.labels(checked.name).inc()
    await _enforce_row_cap(conn, ctx, tbl, max_rows)
    return seq


async def read(
    conn: AsyncConnection,
    ctx: SecurityContext,
    cursor: str | None = None,
    max_events: int = DEFAULT_MAX_EVENTS,
    max_age_ms: int | None = None,
    *,
    next_poll_ms: int | None = None,
    table: sa.Table | None = None,
) -> dict[str, Any]:
    """Answer one poll: the events after ``cursor``, oldest first.

    Returns the poll result — ``events``, ``cursor``, ``truncated``,
    ``hasMore``, and ``nextPollMs`` when the caller supplies one. Each event is
    an ``EventOccurrence`` carrying its own ``cursor``, so a reader that stops
    part-way through a batch can resume from where it stopped.

    ``cursor`` of ``None`` bootstraps: no history, just a cursor, so a newly
    installed connector does not open with a backlog nobody asked for. The rows
    it skips are stamped as decided rather than left unread — otherwise nothing
    could ever prune them or re-emit their ids (:func:`_stamp_skipped`).
    ``max_age_ms`` bounds replay — the floor is the later of the cursor and
    ``now - max_age_ms``, and rows the floor excludes make the answer
    ``truncated``. ``max_events`` is capped at :data:`MAX_MAX_EVENTS`; a batch
    cut there answers ``hasMore``.

    The read also carries retention: it stamps ``first_read_at`` on what it
    returns and deletes what has carried one for :data:`RETENTION`, in this
    transaction, under this caller's RLS.
    """
    tbl = table if table is not None else _default_outbox()
    limit = max(1, min(int(max_events), MAX_MAX_EVENTS))
    workspace = tbl.c.workspace_id == ctx.workspace_id

    epoch = await _load_state(conn, ctx, tbl)
    horizon, own_txid, now = await _snapshot(conn)
    metrics.READ.inc()

    position, truncated = _position(cursor, epoch, horizon)
    if position is None:
        # A bootstrap answers with no history, and the cursor it returns puts every
        # existing row permanently behind it. Those rows have to be marked as decided,
        # or they are immortal: retention is keyed on `first_read_at`, so a row that is
        # never returned is never eligible to be pruned, and the `(workspace, event_id)`
        # conflict clause in `emit` then suppresses that event id for the life of the
        # database. See `_stamp_skipped`.
        await _stamp_skipped(conn, tbl, workspace, horizon, now)
        await _prune(conn, tbl, workspace, now)
        metrics.DEPTH.set(await _undelivered(conn, tbl, workspace))
        return _result([], Cursor(epoch, horizon), truncated, False, next_poll_ms)

    conditions = [workspace, tbl.c.txid >= position.watermark]
    visible = tbl.c.txid < horizon
    if own_txid is not None:
        visible = sa.or_(visible, tbl.c.txid == own_txid)
    conditions.append(visible)
    if position.extra_txid is not None:
        conditions.append(
            sa.not_(
                sa.and_(
                    tbl.c.txid == position.extra_txid,
                    tbl.c.seq <= position.extra_seq,
                )
            )
        )

    age_floor = (
        None
        if max_age_ms is None
        else now - timedelta(milliseconds=min(max(max_age_ms, 0), MAX_AGE_MS_CEILING))
    )
    selected = list(conditions)
    if age_floor is not None:
        selected.append(tbl.c.created_at > age_floor)
        if not truncated:
            truncated = await _any_older_than(conn, tbl, conditions, age_floor)

    rows = (
        await conn.execute(
            sa.select(
                tbl.c.seq,
                tbl.c.txid,
                tbl.c.event_id,
                tbl.c.name,
                tbl.c.timestamp,
                tbl.c.data,
                tbl.c.meta,
            )
            .where(sa.and_(*selected))
            .order_by(tbl.c.txid, tbl.c.seq)
            .limit(limit + 1)
        )
    ).all()
    has_more = len(rows) > limit
    rows = rows[:limit]

    # Read AFTER the select, never before it. Both statements take their own
    # snapshot (the session is READ COMMITTED), so a row cap crossed by a
    # concurrent emit in between is visible to the select as rows that are gone
    # and invisible to an earlier read of the watermark — and the poll would
    # then report a complete stream it does not have. Reading second cannot
    # miss it: this snapshot is no older than the select's.
    truncated = truncated or position.watermark <= await _dropped_through(conn, ctx, tbl)

    await _stamp_read(conn, tbl, workspace, rows, now)
    await _prune(conn, tbl, workspace, now)
    metrics.DEPTH.set(await _undelivered(conn, tbl, workspace))

    return _result(
        [_occurrence(row, epoch, horizon) for row in rows],
        _advance(position, rows, epoch, horizon, has_more),
        truncated,
        has_more,
        next_poll_ms,
    )


# --------------------------------------------------------------------------- #
# Cursor arithmetic — where the no-skip property is actually enforced.         #
# --------------------------------------------------------------------------- #


def _position(cursor: str | None, epoch: str, horizon: int) -> tuple[Cursor | None, bool]:
    """Resolve the supplied cursor into a position, and whether it could be honoured.

    ``None`` for the position means bootstrap — answer with a cursor and no
    history. Everything else replays: a cursor this outbox cannot honour is not
    an error, it is ``truncated: true`` plus whatever is still retained, which
    is exactly what the field is for. Loss to the row cap is the other half of
    ``truncated`` and is decided in :func:`read`, after the rows are selected.
    """
    if cursor is None:
        return None, False
    try:
        position = decode_cursor(cursor, epoch=epoch)
    except CursorError:
        return Cursor(epoch, 0), True
    if position.watermark > horizon:
        # The cursor is ahead of the newest transaction the database has: its
        # counter was rewound under us (a restore, a point-in-time recovery).
        # Everything the cursor names now addresses something else.
        return Cursor(epoch, 0), True
    return position, False


def _advance(
    position: Cursor, rows: Sequence[Any], epoch: str, horizon: int, has_more: bool
) -> Cursor:
    """The cursor to answer with, given what this poll delivered.

    Two rules, and between them they are the no-skip guarantee:

      * the watermark never passes the horizon, because a transaction at or
        above it may still commit a row below the last one returned;
      * when the batch was cut at the cap, it does not pass the last row
        returned either.

    The ``extra`` marker carries the rows delivered above the horizon — the
    ones the answering transaction wrote itself. Dropping one only ever costs a
    duplicate, which the host dedupes on ``(source, eventId)``; keeping the
    newest is what stops that duplicate happening at all in the ordinary case.
    """
    if not rows:
        keep = position.extra_txid is not None and position.extra_txid >= horizon
        return Cursor(
            epoch,
            horizon,
            position.extra_txid if keep else None,
            position.extra_seq if keep else None,
        )
    last = rows[-1]
    watermark = min(last.txid, horizon) if has_more else horizon
    return Cursor(epoch, watermark, last.txid, last.seq)


def _occurrence(row: Any, epoch: str, horizon: int) -> dict[str, Any]:
    """One ``EventOccurrence``, with the cursor that resumes just after it."""
    occurrence: dict[str, Any] = {
        "eventId": row.event_id,
        "name": row.name,
        "timestamp": _rfc3339(row.timestamp),
        "data": row.data,
        "cursor": Cursor(epoch, min(row.txid, horizon), row.txid, row.seq).encode(),
    }
    if row.meta:
        occurrence["_meta"] = row.meta
    return occurrence


def _result(
    events: list[dict[str, Any]],
    cursor: Cursor,
    truncated: bool,
    has_more: bool,
    next_poll_ms: int | None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "events": events,
        "cursor": cursor.encode(),
        "truncated": truncated,
        "hasMore": has_more,
    }
    if next_poll_ms is not None:
        result["nextPollMs"] = int(next_poll_ms)
    return result


# --------------------------------------------------------------------------- #
# The statements.                                                              #
# --------------------------------------------------------------------------- #


async def _snapshot(conn: AsyncConnection) -> tuple[int, int | None, datetime]:
    """The horizon, this transaction's own id if it has one, and the DB clock.

    ``pg_current_xact_id_if_assigned`` rather than ``pg_current_xact_id``: the
    second would *assign* an id, turning every poll into a writing transaction
    that holds the horizon down for every other poller. ``NULL`` here means
    this transaction has written nothing, so there is nothing of its own to
    deliver above the horizon.

    The clock comes from the same statement so the age floor and the retention
    cutoff are measured against the clock that stamped the rows.
    """
    row = (
        await conn.execute(
            sa.text(
                "SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS horizon, "
                "pg_current_xact_id_if_assigned()::text::bigint AS own, "
                "now() AS db_now"
            )
        )
    ).one()
    return row.horizon, row.own, row.db_now


async def _load_state(conn: AsyncConnection, ctx: SecurityContext, tbl: sa.Table) -> str:
    """This workspace's outbox epoch, minting the state row if it is new.

    The insert is attempted only when the row is absent, so an ordinary poll of
    an established workspace stays a read and never assigns a transaction id
    (see :func:`_snapshot`).
    """
    state = _state_table(tbl)
    epoch = await conn.scalar(sa.select(state.c.epoch).where(_state_identity(state, ctx)))
    if epoch is not None:
        return epoch

    epoch = await conn.scalar(
        postgresql.insert(state)
        .values(tenant_id=ctx.tenant_id, workspace_id=ctx.workspace_id)
        .on_conflict_do_nothing(index_elements=["tenant_id", "workspace_id"])
        .returning(state.c.epoch)
    )
    if epoch is not None:
        return epoch
    # Another transaction created it between the select and the insert; it has
    # committed by now, so the row is there. `scalar_one` rather than a default,
    # because an absent epoch here would mean the state table is not what this
    # code thinks it is, and answering a poll on that assumption is worse than
    # failing the poll.
    return (
        await conn.execute(sa.select(state.c.epoch).where(_state_identity(state, ctx)))
    ).scalar_one()


async def _dropped_through(conn: AsyncConnection, ctx: SecurityContext, tbl: sa.Table) -> int:
    """The highest transaction id the row cap has dropped for this workspace.

    The one thing that loses an **undelivered** row: the cap drops in the order
    a poll reads, so the loss is always a prefix, and a cursor at or below this
    mark is one that fell behind it.

    Rows the prune removed are not counted, because a pruned row carried a
    ``first_read_at`` and every way that column is written is a reader having
    decided the row: returned to it, or stepped over by its own bootstrap
    (:func:`_stamp_skipped`). Both of those are that reader's own history, so
    they are not a gap to report back to it. That reasoning is what the
    one-cursor-per-outbox contract in :func:`_stamp_skipped` buys — under a
    second, independent cursor a skip would be somebody else's history, and this
    counter would be silent about it.
    """
    state = _state_table(tbl)
    return (
        await conn.scalar(
            sa.select(state.c.dropped_through_txid).where(_state_identity(state, ctx))
        )
        or 0
    )


def _state_identity(state: sa.Table, ctx: SecurityContext) -> Any:
    return sa.and_(state.c.tenant_id == ctx.tenant_id, state.c.workspace_id == ctx.workspace_id)


async def _any_older_than(
    conn: AsyncConnection,
    tbl: sa.Table,
    conditions: list[Any],
    age_floor: datetime,
) -> bool:
    """Whether ``max_age_ms`` is hiding anything the cursor would have returned.

    That is what ``truncated`` means: events after the supplied cursor that
    this answer does not carry and never will.
    """
    found = await conn.scalar(
        sa.select(tbl.c.seq).where(sa.and_(*conditions, tbl.c.created_at <= age_floor)).limit(1)
    )
    return found is not None


async def _stamp_read(
    conn: AsyncConnection,
    tbl: sa.Table,
    workspace: Any,
    rows: Sequence[Any],
    now: datetime,
) -> None:
    """Start the retention clock on rows this poll returned, once each."""
    if not rows:
        return
    await conn.execute(
        tbl.update()
        .where(workspace, tbl.c.seq.in_([row.seq for row in rows]), tbl.c.first_read_at.is_(None))
        .values(first_read_at=now)
    )


async def _stamp_skipped(
    conn: AsyncConnection,
    tbl: sa.Table,
    workspace: Any,
    horizon: int,
    now: datetime,
) -> None:
    """Start the retention clock on rows a bootstrap decided never to deliver.

    A read with no cursor answers with no history *and* a cursor at the snapshot horizon,
    so every row below that horizon is now permanently behind the reader. That is the
    documented behaviour and it is the right one — a newly installed connector should not
    open with a backlog nobody asked for — but it leaves those rows in a state nothing
    else in this module can resolve.

    ``first_read_at`` is what starts retention, and :func:`_prune` deletes on it. A row
    that is never *returned* never carries one, so it is never pruned; and because
    :func:`emit` is ``ON CONFLICT DO NOTHING`` over ``(workspace_id, event_id)``, the id
    it holds can never be emitted again either. An event a server derives from a stable
    key — a domain transition keyed on its provider id, say — is then permanently
    unannounceable to that workspace, and both sides are silent about it.

    So the column means "when this row stopped being deliverable", and a bootstrap
    stopping it counts. Skipping is a decision the reader made, exactly as returning is;
    stamping it makes a skipped row age out on the same seven days as a delivered one,
    and frees its key on the same schedule.

    Only rows the cursor actually passed. Anything at or above the horizon belongs to a
    transaction that may still commit below the last row returned, and the next poll owes
    it — which is the whole point of the horizon and must not be undone here.

    NOT a timeout. A row left unread because a workspace's poll is simply behind keeps a
    null ``first_read_at`` and lives until it is delivered, as it does today.

    **This is correct under one reader per workspace outbox, and that is a contract the
    library requires and cannot check.** The predicate is every undelivered row below the
    horizon, which equals "what THIS bootstrap stepped over" only while a single cursor
    addresses this outbox. A second, independent cursor would have its owed rows stamped
    by somebody else's bootstrap, pruned seven days later, and — because ``truncated``
    keys on :func:`_dropped_through`, which only the row cap writes — never told.

    The contract holds by construction for every adopter: an outbox belongs to one server,
    the host keeps one cursor per ``(workspace, connector)``, and a connector addresses one
    server. Retention has no reader identity, so nothing here would notice a host that
    broke it. Giving it one is a schema change and a different piece of work; until then a
    host that fans two cursors onto one outbox is outside this library's contract.
    """
    await conn.execute(
        tbl.update()
        .where(workspace, tbl.c.first_read_at.is_(None), tbl.c.txid < horizon)
        .values(first_read_at=now)
    )


async def _prune(conn: AsyncConnection, tbl: sa.Table, workspace: Any, now: datetime) -> None:
    """Drop what has been delivered and held for :data:`RETENTION`."""
    await conn.execute(tbl.delete().where(workspace, tbl.c.first_read_at < now - RETENTION))


async def _undelivered(conn: AsyncConnection, tbl: sa.Table, workspace: Any) -> int:
    """Rows this workspace has never had returned to it."""
    return (
        await conn.scalar(
            sa.select(sa.func.count())
            .select_from(tbl)
            .where(workspace, tbl.c.first_read_at.is_(None))
        )
        or 0
    )


async def _enforce_row_cap(
    conn: AsyncConnection, ctx: SecurityContext, tbl: sa.Table, max_rows: int
) -> None:
    """Hold one workspace's outbox to ``max_rows``, dropping the oldest.

    Dropping in **read order** rather than by age matters: the loss is then a
    prefix of what a poll would have returned, so recording the highest
    transaction id dropped is enough to tell any cursor whether it fell behind
    the retained rows. A cursor at or below that mark is answered ``truncated``.

    The boundary lookup walks ``max_rows`` index entries and returns nothing
    while the outbox is under the cap, so the delete is a second round trip only
    for the workspace that is actually over it.
    """
    if max_rows < 1:
        raise ValueError("max_rows must be at least 1")
    workspace = tbl.c.workspace_id == ctx.workspace_id
    boundary = (
        await conn.execute(
            sa.select(tbl.c.txid, tbl.c.seq)
            .where(workspace)
            .order_by(tbl.c.txid.desc(), tbl.c.seq.desc())
            .offset(max_rows - 1)
            .limit(1)
        )
    ).first()
    if boundary is None:
        return

    dropped = (
        await conn.execute(
            tbl.delete()
            .where(
                workspace,
                sa.tuple_(tbl.c.txid, tbl.c.seq)
                < sa.tuple_(sa.literal(boundary.txid), sa.literal(boundary.seq)),
            )
            .returning(tbl.c.txid)
        )
    ).all()
    if not dropped:
        return

    metrics.CAPPED.inc(len(dropped))
    state = _state_table(tbl)
    highest = max(row.txid for row in dropped)
    upsert = postgresql.insert(state).values(
        tenant_id=ctx.tenant_id,
        workspace_id=ctx.workspace_id,
        dropped_through_txid=highest,
    )
    await conn.execute(
        upsert.on_conflict_do_update(
            index_elements=["tenant_id", "workspace_id"],
            set_={
                "dropped_through_txid": sa.func.greatest(
                    state.c.dropped_through_txid, upsert.excluded.dropped_through_txid
                )
            },
        )
    )


# --------------------------------------------------------------------------- #
# Plumbing.                                                                    #
# --------------------------------------------------------------------------- #

#: The default-named table, for adopters that did not rename it. A
#: :class:`~sqlalchemy.Table` is only a handle for building statements, so this
#: one does not have to be the object the adopter migrated with; an adopter that
#: renamed the table passes its own to ``emit`` / ``read``.
_DEFAULT_OUTBOX = outbox_table(sa.MetaData())


def _default_outbox() -> sa.Table:
    return _DEFAULT_OUTBOX


def _state_table(table: sa.Table) -> sa.Table:
    return table.metadata.tables[f"{table.name}_state"]


def _compile(element: Any) -> str:
    return str(element.compile(dialect=postgresql.dialect())).strip()


def _rfc3339(value: datetime) -> str:
    """The wire form of a timestamp: ISO 8601 in UTC, ``Z``-suffixed.

    The column is a ``timestamptz``, so what a server wrote with an offset
    comes back as the same instant normalized to UTC — one form on the wire
    rather than one per emitter.
    """
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
