"""Tools walled to the workspace the host context names, and timed on the host's clock."""

from fastmcp import Context, FastMCP

from nimblebrain_server_sdk import (
    ADDS,
    CHANGES,
    READS,
    HostContext,
    add_error_contract,
    host_context,
)
from nimblebrain_server_sdk.errors import ErrorCode, ServiceError

mcp = FastMCP("journal")
add_error_contract(mcp)

ENTRIES: dict[str, list[dict[str, str]]] = {}


def walled(ctx: Context) -> tuple[HostContext, str]:
    """The call's host context and the workspace it is walled to, or `auth_required`."""
    context = host_context(ctx)  # None when the call carries no context, or a malformed one
    if context is None or context.workspace_id is None:
        raise ServiceError(ErrorCode.AUTH_REQUIRED, "This call names no workspace.")
    return context, context.workspace_id


@mcp.tool(annotations=ADDS)
async def add_entry(text: str, ctx: Context) -> dict[str, str]:
    """Add an entry to the caller's workspace journal."""
    context, workspace = walled(ctx)
    if context.now is None:
        raise ServiceError(ErrorCode.AUTH_REQUIRED, "This call carries no host clock.")
    entry = {"text": text, "at": context.now}  # the host's clock, never the server's
    ENTRIES.setdefault(workspace, []).append(entry)
    return entry


@mcp.tool(annotations=READS)
async def list_entries(ctx: Context) -> list[dict[str, str]]:
    """List the entries in the caller's workspace journal."""
    _, workspace = walled(ctx)
    return ENTRIES.get(workspace, [])


@mcp.tool(annotations=CHANGES)
async def clear_workspace(ctx: Context) -> dict[str, int]:
    """Delete every entry in a workspace. Only the host calls this."""
    context, workspace = walled(ctx)
    if not context.is_host:  # a person, through an agent or an app, is refused
        raise ServiceError(ErrorCode.FORBIDDEN, "Only the host clears a workspace.")
    return {"deleted": len(ENTRIES.pop(workspace, []))}
