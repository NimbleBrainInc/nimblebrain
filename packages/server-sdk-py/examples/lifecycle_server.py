"""A server the host tells when a workspace gains it and when it is about to be removed."""

from fastmcp import FastMCP

from nimblebrain_server_sdk import CHANGES, add_lifecycle_extension

mcp = FastMCP("notes")
lifecycle = add_lifecycle_extension(mcp)

PREPARED: set[str] = set()


@lifecycle.handler("ready", annotations=CHANGES)
async def workspace_ready(reason: str | None = None) -> str:
    """Prepare this workspace. `reason` is `install` or `resume`."""
    PREPARED.add("workspace")  # idempotent: the host may deliver `ready` more than once
    return f"ready ({reason or 'unspecified'})"


@lifecycle.handler("removing", annotations=CHANGES)
async def workspace_removing() -> str:
    """Record that this workspace is being removed. Never destroy data here."""
    PREPARED.discard("workspace")
    return "removal recorded"
