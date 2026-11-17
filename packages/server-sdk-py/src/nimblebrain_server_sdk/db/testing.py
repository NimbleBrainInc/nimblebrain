"""Test helpers for a server built on :class:`~nimblebrain_server_sdk.db.SecuredDatabase`."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Mapping
from contextlib import asynccontextmanager

from fastmcp import Client, FastMCP
from pgbulkhead.testing import use_limiter

from nimblebrain_server_sdk.testing import Mode

from .edge import TENANT_HEADER, WORKSPACE_HEADER

__all__ = ["edge_client", "use_limiter"]


@asynccontextmanager
async def edge_client(
    mcp: FastMCP,
    *,
    tenant_id: str,
    workspace_id: str,
    headers: Mapping[str, str] | None = None,
    mode: Mode = "auto",
) -> AsyncGenerator[Client]:
    """A client whose calls reach ``mcp`` with a verified identity, for a test.

    The in-memory ``fastmcp.Client(mcp)`` sends no HTTP headers, so a tool that reads its
    identity with ``security_context_from_edge_headers(get_http_headers())`` raises
    ``AuthError`` under it. This serves ``mcp`` over HTTP inside the test's own event loop (no
    port is bound) and yields a client that sends ``x-tenant-id`` and ``x-workspace-id`` on
    every request, which is how the edge delivers one. ``headers`` adds others, such as the
    one a server reads a user id from. The server's lifespan runs for the length of the block.

    **For tests only.** It changes nothing in the server: identity still arrives in the two
    headers and nowhere else, so it opens no way for a tool argument or a request body to
    carry one. The test stands where the edge stands in production, the one party the server
    trusts to set those headers; a deployment keeps that true by admitting only the edge.
    """
    from fastmcp.utilities.tests import asgi_client

    sent = {**(headers or {}), TENANT_HEADER: tenant_id, WORKSPACE_HEADER: workspace_id}
    async with asgi_client(mcp, headers=sent, mode=mode) as client:
        yield client
