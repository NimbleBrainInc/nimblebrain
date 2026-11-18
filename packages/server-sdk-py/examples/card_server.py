"""A server that describes itself with an MCP Server Card, read before a host connects."""

from fastmcp import FastMCP
from mcp.types import Icon

from nimblebrain_server_sdk import READS, add_server_card

mcp = FastMCP(
    "com.example/notes",  # the card's name: reverse-DNS, one slash
    version="1.2.0",
    website_url="https://example.com/notes",
    icons=[Icon(src="https://example.com/notes.png", mime_type="image/png")],
)
add_server_card(
    mcp,
    title="Notes",
    description="Saves and reads short notes.",
    placements=[
        {
            "slot": "sidebar.apps",
            "resourceUri": "ui://notes/board",
            "label": "Notes",
            "route": "notes",
        }
    ],
)


@mcp.resource("ui://notes/board", mime_type="text/html;profile=mcp-app")
async def board() -> str:
    return "<!doctype html><p>Notes</p>"


@mcp.tool(annotations=READS)
async def count_notes() -> int:
    """How many notes there are."""
    return 0


if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8000)  # card at /mcp/server-card
