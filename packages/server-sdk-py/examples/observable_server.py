"""A server with metrics, JSON logs and traces, set up in one call."""

from fastmcp import FastMCP

from nimblebrain_server_sdk import ADDS
from nimblebrain_server_sdk.observability import (
    counter,
    get_logger,
    instrument_app,
    service_version,
)

mcp = FastMCP("notes", version=service_version())  # SERVICE_VERSION, else "dev"
log = get_logger(__name__)
NOTES_ADDED = counter("notes_added_total", "Notes added.")  # on the same registry as the rest


@mcp.tool(annotations=ADDS)
async def add_note(text: str) -> dict[str, bool]:
    """Add a note."""
    NOTES_ADDED.inc()
    log.info("note_added", length=len(text))  # one JSON line, with the request's identity
    return {"saved": True}


app = mcp.http_app()
instrument_app(app, service="notes")  # GET /metrics, request metrics, logs, trace propagation

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
