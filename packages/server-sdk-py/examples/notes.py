"""A complete connector: two tools, a count the host shows, and the error contract."""

from fastmcp import Context, FastMCP

from nimblebrain_server_sdk import (
    ADDS,
    FACETS_EXTENSION_ID,
    READS,
    add_error_contract,
    add_platform_extension,
    announce_resource_list_changed,
    facet_count,
    facet_meta,
    new_prefixed_id,
)
from nimblebrain_server_sdk.errors import ErrorCode, ServiceError

mcp = FastMCP("notes")
add_error_contract(mcp)  # a ServiceError a tool raises reaches the caller with its code
add_platform_extension(mcp, FACETS_EXTENSION_ID)

NOTES: dict[str, str] = {}


@mcp.tool(annotations=ADDS)
async def save_note(text: str, ctx: Context) -> dict[str, str]:
    """Save a note and return its id."""
    if not text.strip():
        raise ServiceError(ErrorCode.BAD_INPUT, "`text` is empty.")
    note_id = new_prefixed_id("nt")
    NOTES[note_id] = text
    await announce_resource_list_changed(ctx)  # after the write, so open views re-read
    return {"id": note_id}


@mcp.tool(annotations=READS)
async def get_note(note_id: str) -> dict[str, str]:
    """Read one note by id."""
    if note_id not in NOTES:
        raise ServiceError(ErrorCode.NOT_FOUND, "No note has that id.")
    return {"id": note_id, "text": NOTES[note_id]}


@mcp.resource(
    "notes://facets/total",
    name="notes-total",
    title="Notes",
    mime_type="application/json",
    meta=facet_meta("info"),
)
async def notes_total() -> str:
    return facet_count(len(NOTES))


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8000)
