"""A server that keeps its notes in Postgres, isolated per tenant and workspace by RLS."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import sqlalchemy as sa
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers

from nimblebrain_server_sdk import ADDS, READS, add_error_contract
from nimblebrain_server_sdk.db import SecuredDatabase, security_context_from_edge_headers

# NOTES_DATABASE_URL=postgresql+asyncpg://notes_app:...@host:5432/notes  (the app role)
db = SecuredDatabase(url_env="NOTES_DATABASE_URL", prefix="NOTES")

metadata = sa.MetaData()
notes = sa.Table(
    "notes",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True),
    sa.Column("tenant_id", sa.Text, nullable=False),
    sa.Column("workspace_id", sa.Text, nullable=False),
    sa.Column("text", sa.Text, nullable=False),
)


@asynccontextmanager
async def lifespan(_: FastMCP) -> AsyncIterator[None]:
    db.check()  # the pool settings are valid
    await db.check_role()  # the role is one row-level security applies to
    yield
    await db.dispose()


mcp = FastMCP("notes", lifespan=lifespan)
add_error_contract(mcp)  # a missing identity is `auth_required`, a full pool `rate_limited`


@mcp.tool(annotations=ADDS)
async def add_note(text: str) -> dict[str, bool]:
    """Add a note to the caller's workspace."""
    ctx = security_context_from_edge_headers(get_http_headers())  # AuthError when absent
    async with db.session(ctx) as conn:  # admitted, then bound to ctx for RLS
        await conn.execute(notes.insert().values(**ctx.identity_columns(), text=text))
    return {"saved": True}


@mcp.tool(annotations=READS)
async def list_notes() -> list[str]:
    """List the notes the caller's workspace can read."""
    ctx = security_context_from_edge_headers(get_http_headers())
    async with db.session(ctx) as conn:  # no WHERE clause: the policy filters the rows
        return list((await conn.execute(sa.select(notes.c.text))).scalars())
