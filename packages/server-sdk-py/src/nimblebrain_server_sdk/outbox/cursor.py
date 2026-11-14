"""The opaque poll cursor.

A cursor answers one question: **what has this reader already been given?** It
is opaque to the caller by contract — the host stores it and hands it back —
which is what lets it carry more than the "position" a sequence number can.

What it carries, and why each field has to be there:

  * ``epoch`` — a value minted once per workspace outbox. A database restored
    from a dump keeps its rows but resets its transaction counter, so a cursor
    from before the restore addresses a position that now means something else.
    The epoch makes that detectable instead of silent.
  * ``w`` — the **snapshot-horizon watermark**: every row whose transaction id
    is below it has been delivered. This is the whole commit-order property.
    Transaction A takes a transaction id, B takes a later one and commits
    first; A's row is invisible, so no reader can see it to skip it. Bounding
    delivery at the horizon (the oldest transaction still running) means the
    watermark can never advance past A, and A surfaces on the poll after it
    commits.
  * ``x`` / ``xs`` — the one exception the watermark cannot express. A server
    may emit *inside the transaction that answers the poll* (the read is its
    tick), and those rows are visible to that transaction alone, above the
    horizon. They are delivered eagerly, and this pair records how far: "also
    already delivered, from transaction ``x``, through row ``xs``". Without it
    those events arrive twice on the next poll; with it, once.

The delivered set is therefore ``{txid < w} ∪ {txid = x and seq <= xs}`` and the
predicate that reads the rest is its complement. Both are one expression in
:mod:`nimblebrain_server_sdk.outbox.core`.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass

#: Wire prefix. A cursor that does not carry it is from another scheme (or
#: another library) and is refused rather than guessed at.
_PREFIX = "nbo1:"

#: Longest cursor accepted, matching the runtime's own bound on the field. Ours
#: are ~90 characters; anything near this is not one of ours.
MAX_CURSOR_LENGTH = 1024

#: Every number in a cursor addresses a ``bigint`` column or is compared against
#: one, so one outside that range is not a position this outbox could have
#: issued. Bounded here rather than at the query, where an out-of-range bind is
#: a driver error instead of a cursor this outbox declines to honour.
_MAX_POSITION = 2**63 - 1


class CursorError(ValueError):
    """A cursor that cannot be honoured — malformed, or from another epoch.

    Always recoverable: the caller replies with a fresh cursor and
    ``truncated: true``, which is precisely what the field means.
    """


@dataclass(frozen=True, slots=True)
class Cursor:
    """A decoded cursor. See the module docstring for what each field means."""

    epoch: str
    watermark: int
    extra_txid: int | None = None
    extra_seq: int | None = None

    def encode(self) -> str:
        """Render to the opaque wire string."""
        payload: list[int | str | None] = [self.epoch, self.watermark]
        if self.extra_txid is not None:
            payload.extend((self.extra_txid, self.extra_seq))
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return _PREFIX + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode(value: str, *, epoch: str) -> Cursor:
    """Decode a cursor and bind it to this outbox's ``epoch``.

    Raises :class:`CursorError` for anything that cannot be honoured, including
    a well-formed cursor from a different epoch — the caller turns that into
    ``truncated: true`` plus a replay of what is retained.
    """
    if len(value) > MAX_CURSOR_LENGTH:
        raise CursorError("cursor is longer than this outbox ever issues")
    if not value.startswith(_PREFIX):
        raise CursorError("cursor was not issued by this outbox")
    body = value[len(_PREFIX) :]
    try:
        raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        payload = json.loads(raw)
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise CursorError("cursor is not decodable") from exc

    if not isinstance(payload, list) or len(payload) not in (2, 4):
        raise CursorError("cursor does not carry the expected fields")
    cursor_epoch, watermark = payload[0], payload[1]
    if not isinstance(cursor_epoch, str) or not isinstance(watermark, int):
        raise CursorError("cursor does not carry the expected field types")
    if not _is_position(watermark):
        raise CursorError("cursor watermark is not a transaction id")
    if cursor_epoch != epoch:
        raise CursorError("cursor was issued against a different epoch of this outbox")

    if len(payload) == 2:
        return Cursor(epoch=cursor_epoch, watermark=watermark)

    extra_txid, extra_seq = payload[2], payload[3]
    if not _is_position(extra_txid) or not _is_position(extra_seq):
        raise CursorError("cursor extra marker is not a position")
    return Cursor(
        epoch=cursor_epoch,
        watermark=watermark,
        extra_txid=extra_txid,
        extra_seq=extra_seq,
    )


def _is_position(value: object) -> bool:
    """A non-negative integer a ``bigint`` column could hold."""
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_POSITION
