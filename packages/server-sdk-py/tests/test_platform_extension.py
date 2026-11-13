"""A platform extension is advertised through ``server/discover`` and nowhere else.

The capability map rides the 2026-07-28 discovery call. A legacy ``initialize`` never carries
it, so a session-era peer sees the same server with no extensions at all.
"""

from __future__ import annotations

from typing import Any

import httpx2
import pytest
from fastmcp import FastMCP

from nimblebrain_server_sdk import add_platform_extension

HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
MODERN = "2026-07-28"
CLIENT_INFO = {"name": "probe", "version": "0"}


async def _post(probe: FastMCP, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    app = probe.http_app(json_response=True)
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://p") as http,
    ):
        response = await http.post("/mcp", headers={**HEADERS, **headers}, json=body)
    return response.json()


async def _discover(probe: FastMCP) -> dict[str, Any]:
    reply = await _post(
        probe,
        {"mcp-protocol-version": MODERN, "mcp-method": "server/discover"},
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "server/discover",
            "params": {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": MODERN,
                    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
                    "io.modelcontextprotocol/clientCapabilities": {},
                }
            },
        },
    )
    return reply["result"]["capabilities"]


async def test_discovery_advertises_the_extension_with_its_settings():
    probe = FastMCP("probe")
    add_platform_extension(probe, "ai.nimblebrain/probe", {"version": 1})

    capabilities = await _discover(probe)

    assert capabilities["extensions"]["ai.nimblebrain/probe"] == {"version": 1}


async def test_an_extension_without_settings_advertises_an_empty_object():
    probe = FastMCP("probe")
    add_platform_extension(probe, "ai.nimblebrain/probe")

    capabilities = await _discover(probe)

    assert capabilities["extensions"]["ai.nimblebrain/probe"] == {}


async def test_a_legacy_handshake_carries_no_extensions():
    probe = FastMCP("probe")
    add_platform_extension(probe, "ai.nimblebrain/probe")

    reply = await _post(
        probe,
        {},
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": CLIENT_INFO,
            },
        },
    )

    assert "extensions" not in reply["result"]["capabilities"]


def test_the_sdk_refuses_an_identifier_without_a_vendor_prefix():
    with pytest.raises(TypeError, match="vendor-prefix/name"):
        add_platform_extension(FastMCP("probe"), "facets")


def test_an_identifier_is_advertised_once():
    probe = FastMCP("probe")
    add_platform_extension(probe, "ai.nimblebrain/probe")

    with pytest.raises(ValueError, match="already registered"):
        add_platform_extension(probe, "ai.nimblebrain/probe")


async def test_the_set_is_fixed_once_the_server_is_serving():
    probe = FastMCP("probe")
    app = probe.http_app()

    async with app.router.lifespan_context(app):
        with pytest.raises(RuntimeError, match="lifespan has already started"):
            add_platform_extension(probe, "ai.nimblebrain/late")
