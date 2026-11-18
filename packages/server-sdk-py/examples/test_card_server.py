"""The Server Card as a host fetches it: under the MCP path, before it connects."""

import httpx2
from card_server import mcp

from nimblebrain_server_sdk import SERVER_CARD_MEDIA_TYPE


async def test_the_card_is_served_under_the_mcp_path() -> None:
    app = mcp.http_app()  # the streamable-HTTP app `mcp.run(transport="http")` serves
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url="http://127.0.0.1") as http:
        response = await http.get("/mcp/server-card", headers={"accept": SERVER_CARD_MEDIA_TYPE})
    assert response.status_code == 200
    assert response.headers["content-type"] == SERVER_CARD_MEDIA_TYPE
    card = response.json()
    assert (card["name"], card["version"], card["title"]) == ("com.example/notes", "1.2.0", "Notes")
    assert (
        card["_meta"]["ai.nimblebrain/host"]["placements"][0]["resourceUri"] == "ui://notes/board"
    )
