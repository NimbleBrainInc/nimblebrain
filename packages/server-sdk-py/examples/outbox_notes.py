"""The Postgres notes server, recording a notification when a note is shared."""

from datetime import UTC, datetime

import sqlalchemy as sa
from db_notes import db, mcp, notes
from fastmcp.server.dependencies import get_http_headers

from nimblebrain_server_sdk import CHANGES, new_prefixed_id
from nimblebrain_server_sdk.db import SecurityContext, security_context_from_edge_headers
from nimblebrain_server_sdk.errors import ErrorCode, ServiceError
from nimblebrain_server_sdk.outbox import emit, register_outbox

OUTBOX = "notes://notifications"  # the URI the server's catalog entry declares


def identity() -> SecurityContext:
    return security_context_from_edge_headers(get_http_headers())


# Serve the outbox with the session factory and identity the tools already use.
register_outbox(mcp, OUTBOX, db.session, identity)


@mcp.tool(annotations=CHANGES)
async def share_note(note_id: int, with_person: str) -> dict[str, bool]:
    """Share a note with someone, and tell the workspace it was shared."""
    ctx = identity()
    async with db.session(ctx) as conn:
        text = await conn.scalar(sa.select(notes.c.text).where(notes.c.id == note_id))
        if text is None:
            raise ServiceError(ErrorCode.NOT_FOUND, "No note has that id.")
        # The state change would go here. The notification is appended on the same
        # connection, so it commits with the change or not at all.
        await emit(
            conn,
            ctx,
            {
                "eventId": new_prefixed_id("ev"),
                "name": "note.shared",
                "timestamp": datetime.now(UTC),
                "data": {"note_id": note_id, "with": with_person},
            },
            title=f"A note was shared with {with_person}"[:200],
            level="info",
            subject=with_person[:200],
        )
    return {"shared": True}
