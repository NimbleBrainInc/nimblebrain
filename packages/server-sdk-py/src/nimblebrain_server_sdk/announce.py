"""Tell the client that made a write that this server's resource list changed."""

from __future__ import annotations

import logging

from fastmcp import Context
from fastmcp.server.dependencies import get_context
from mcp.types import ResourceListChangedNotification

logger = logging.getLogger(__name__)


async def announce_resource_list_changed(
    ctx: Context | None = None, *, tool: str | None = None
) -> None:
    """Send ``notifications/resources/list_changed`` in the response to the call that wrote.

    That call came from the host that holds this workspace, so the notification is scoped to
    the workspace without the server keeping a map of sessions. The host relays it to this
    server's views, which re-read.

    Call it only from a write, once the write has committed. A read never calls it: a view
    re-reads when told the list changed, so a read that announced would have every open view
    refreshing itself forever.

    ``ctx`` defaults to the active MCP request's context. With neither there is no response to
    announce in — a tool body called directly, or a write made outside any tool call — and
    that is not a failure. Nor is a send that fails: the write is stored either way, and
    reporting a stored write as failed would have the agent make it a second time. A view
    that misses one catches up on its next read.

    ``tool`` names the calling tool on that failure's log line.
    """
    if ctx is None:
        try:
            ctx = get_context()
        except RuntimeError:
            return
    try:
        # Tied to the request, so it travels in the call's own response. A 2026-07-28
        # connection has no other way out, and a session-era client need not hold the
        # standalone stream open.
        await ctx.send_notification(ResourceListChangedNotification())
    except Exception:  # the write already committed; see above
        logger.warning("announce_resource_list_changed_failed", exc_info=True, extra={"tool": tool})
