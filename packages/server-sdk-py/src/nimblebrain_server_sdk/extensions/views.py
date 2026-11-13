"""Name the view that shows a kind of record (``ai.nimblebrain/view``).

A server with several sidebar views keeps each kind of record in one of them. Its resource
template for that record carries the key, holding the ``ui://`` URI of the view (its
placement's ``resourceUri``), and a host that opens a record by its URI opens it in that view
rather than the server's first. A host that does not read the key opens the first view; the
key names only one of the server's own views.

    @mcp.resource(
        "acme://boards/{board_id}",
        name="board",
        mime_type="application/json",
        meta=record_view_meta("ui://acme/boards"),
    )
    async def board(board_id: str) -> str: ...
"""

from __future__ import annotations

from typing import Any

RECORD_VIEW_META = "ai.nimblebrain/view"


def record_view_meta(view_uri: str) -> dict[str, Any]:
    """The ``_meta`` a record's resource template carries to name the view that shows it.

    Raises :class:`ValueError` for anything but a ``ui://`` URI, which a host would ignore and
    which would leave the record opening in the server's first view without a sign of why.
    """
    if not view_uri.startswith("ui://") or len(view_uri) <= len("ui://"):
        raise ValueError(f"a record's view is a ui:// URI, not {view_uri!r}")
    return {RECORD_VIEW_META: view_uri}
