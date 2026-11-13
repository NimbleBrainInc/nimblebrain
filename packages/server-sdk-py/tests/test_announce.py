"""The announcement: in the call's own response, on both protocol eras, and never raised.

Over streamable HTTP, a notification sent without naming the request that caused it goes to
a session-era client's optional GET stream, and is dropped when the client has none open; a
2026-07-28 connection has no such stream at all. Tied to the tool call, it travels in that
call's own response, which the client is always reading. An in-memory client has no separate
streams, so only an HTTP exchange can tell the two apart.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx2
import pytest
from fastmcp import Context, FastMCP

from nimblebrain_server_sdk import announce_resource_list_changed

HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
LEGACY = "2025-11-25"
MODERN = "2026-07-28"
CLIENT_INFO = {"name": "probe", "version": "0"}


async def _call_legacy(http: httpx2.AsyncClient, tool: str) -> httpx2.Response:
    """Initialize a session, then call ``tool`` on it."""
    init = await http.post(
        "/mcp",
        headers=HEADERS,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": LEGACY, "capabilities": {}, "clientInfo": CLIENT_INFO},
        },
    )
    session = {
        **HEADERS,
        "mcp-session-id": init.headers["mcp-session-id"],
        "mcp-protocol-version": LEGACY,
    }
    await http.post(
        "/mcp", headers=session, json={"jsonrpc": "2.0", "method": "notifications/initialized"}
    )
    return await http.post(
        "/mcp",
        headers=session,
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool}},
    )


async def _call_modern(http: httpx2.AsyncClient, tool: str) -> httpx2.Response:
    """Call ``tool`` in one sessionless request, the client's envelope in ``_meta``."""
    return await http.post(
        "/mcp",
        headers={
            **HEADERS,
            "mcp-protocol-version": MODERN,
            "mcp-method": "tools/call",
            "mcp-name": tool,
        },
        json={
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": tool,
                "arguments": {},
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": MODERN,
                    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
                    "io.modelcontextprotocol/clientCapabilities": {},
                },
            },
        },
    )


async def _call_over_http(probe: FastMCP, tool: str, era: str) -> list[dict[str, Any]]:
    """Call ``tool`` once on ``era`` and return every message in its response."""
    app = probe.http_app()
    transport = httpx2.ASGITransport(app=app)
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=transport, base_url="http://probe") as http,
    ):
        call = await (_call_modern if era == MODERN else _call_legacy)(http, tool)
    # A response with nothing to stream ahead of the result is sent as plain JSON.
    if call.headers["content-type"].startswith("application/json"):
        return [call.json()]
    return [
        json.loads(line.removeprefix("data:"))
        for line in call.text.splitlines()
        if line.startswith("data:")
    ]


@pytest.mark.parametrize("era", [LEGACY, MODERN])
@pytest.mark.parametrize("pass_ctx", [True, False], ids=["given-ctx", "active-request"])
async def test_the_announcement_travels_in_the_tool_call_s_own_response(pass_ctx: bool, era: str):
    probe = FastMCP("probe")

    @probe.tool()
    async def write(ctx: Context) -> str:
        await announce_resource_list_changed(ctx if pass_ctx else None)
        return "ok"

    messages = await _call_over_http(probe, "write", era)

    assert [m["method"] for m in messages if "method" in m] == [
        "notifications/resources/list_changed"
    ]
    assert any(m.get("id") == 2 and "result" in m for m in messages)


async def test_outside_a_request_there_is_nothing_to_announce_on():
    await announce_resource_list_changed()


@pytest.mark.parametrize("era", [LEGACY, MODERN])
async def test_a_failed_send_is_logged_and_not_raised(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch, era: str
):
    probe = FastMCP("probe")

    @probe.tool()
    async def write(ctx: Context) -> str:
        async def refuse(*_args: object, **_kwargs: object) -> None:
            raise ConnectionError("the stream closed")

        monkeypatch.setattr(ctx, "send_notification", refuse)
        await announce_resource_list_changed(ctx, tool="write")
        return "stored"

    with caplog.at_level(logging.WARNING, logger="nimblebrain_server_sdk.announce"):
        messages = await _call_over_http(probe, "write", era)

    [response] = [m for m in messages if m.get("id") == 2]
    assert response["result"]["content"][0]["text"] == "stored"
    assert not response["result"].get("isError")
    [record] = caplog.records
    assert record.message == "announce_resource_list_changed_failed"
    assert record.__dict__["tool"] == "write"
