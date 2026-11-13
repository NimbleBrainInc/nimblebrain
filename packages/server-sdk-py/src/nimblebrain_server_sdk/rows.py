"""The row a listing or a search returns: the record, bounded, with its address.

A page holds up to a few hundred rows, so one unbounded text field (a document's body, a
note's text, a ticket's description) multiplies into a page no agent context can hold. A row carries
such a field as a fixed-length preview or not at all, and its ``uri`` is the address the
whole record is read from. A server builds each row with :func:`listing_row`::

    rows = [listing_row(dump(r), omit=("body",)) for r in page.rows]
    rows = [listing_row(row, preview={"content": PREVIEW_CHARS}) for row in rows]

``nimblebrain_server_sdk.testing.assert_bounded_rows`` checks a page the way this module shapes it.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

PREVIEW_CHARS = 200
"""A preview's default length in characters: enough to recognise a record, not to read it."""

ELLIPSIS = "…"


def preview_text(text: str, chars: int = PREVIEW_CHARS) -> str:
    """``text`` cut to at most ``chars`` characters, ending in ``…`` when anything was cut."""
    if chars < 1:
        raise ValueError(f"a preview holds at least one character, not {chars!r}")
    if len(text) <= chars:
        return text
    return text[: chars - 1].rstrip() + ELLIPSIS


def listing_row(
    record: Mapping[str, Any],
    *,
    omit: Iterable[str] = (),
    preview: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """``record`` as a listing row: each ``omit`` field dropped, each ``preview`` field cut.

    A previewed field ``f`` leaves the row and comes back as ``f_preview``, at most
    ``preview[f]`` characters (:func:`preview_text`), so a reader never mistakes a preview
    for the field itself. A ``None`` value stays ``None``. A field the record lacks is
    skipped, so one call serves records that carry it and records that do not. Every other
    key, ``uri`` included, is copied unchanged; the record itself is not modified.

    Raises :class:`TypeError` for a previewed value that is neither text nor ``None``, which
    is a server bug a preview would hide.
    """
    row = dict(record)
    for field in omit:
        row.pop(field, None)
    for field, chars in (preview or {}).items():
        if field not in row:
            continue
        value = row.pop(field)
        if value is not None and not isinstance(value, str):
            raise TypeError(f"{field} is previewed as text, not {type(value).__name__}")
        row[f"{field}_preview"] = None if value is None else preview_text(value, chars)
    return row
