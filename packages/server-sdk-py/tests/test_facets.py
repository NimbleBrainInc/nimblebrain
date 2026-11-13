"""A facet as a host meets it on the wire: advertised, listed with its marker, read as a count.

The host (https://docs.nimblebrain.ai/extensions/facets/) finds the extension in ``server/discover``, takes
the ``resources/list`` entries whose ``_meta`` carries the identifier, and reads each one. These
tests speak raw JSON-RPC over the ASGI app so what they assert is the bytes a host receives.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest
from fastmcp import FastMCP

from nimblebrain_server_sdk import (
    FACETS_EXTENSION_ID,
    add_platform_extension,
    facet_count,
    facet_meta,
)
from nimblebrain_server_sdk.testing import served_facets

HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
MODERN = "2026-07-28"
ENVELOPE = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": {"name": "probe", "version": "0"},
    "io.modelcontextprotocol/clientCapabilities": {},
}


def _probe(count: int = 3) -> FastMCP:
    probe = FastMCP("probe")
    add_platform_extension(probe, FACETS_EXTENSION_ID)

    @probe.resource(
        "probe://waiting",
        name="things-waiting",
        title="Things waiting",
        mime_type="application/json",
        meta=facet_meta("critical"),
    )
    async def things_waiting() -> str:
        return facet_count(count)

    @probe.resource(
        "probe://unleveled",
        name="unleveled",
        title="Things unleveled",
        mime_type="application/json",
        meta={FACETS_EXTENSION_ID: {}},
    )
    async def unleveled() -> str:
        return facet_count(0)

    @probe.resource("probe://plain", name="plain", mime_type="application/json")
    async def plain() -> str:
        return "{}"

    return probe


async def _call(probe: FastMCP, method: str, params: dict[str, str] | None = None) -> Any:
    params = params or {}
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": {**params, "_meta": ENVELOPE}}
    headers = {**HEADERS, "mcp-protocol-version": MODERN, "mcp-method": method}
    if "uri" in params:
        # 2026-07-28 routes a resource request on the Mcp-Name header, which must match the URI.
        headers["mcp-name"] = params["uri"]
    app = probe.http_app(json_response=True)
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://p") as http,
    ):
        response = await http.post("/mcp", headers=headers, json=body)
    return response.json()["result"]


async def test_discovery_advertises_the_extension_with_empty_settings():
    capabilities = (await _call(_probe(), "server/discover"))["capabilities"]

    assert capabilities["extensions"][FACETS_EXTENSION_ID] == {}
    assert "resources" in capabilities


async def test_the_listing_marks_the_facet_and_carries_its_title_and_mime_type():
    listed = {r["name"]: r for r in (await _call(_probe(), "resources/list"))["resources"]}

    facet = listed["things-waiting"]
    assert facet["_meta"][FACETS_EXTENSION_ID] == {"level": "critical"}
    assert facet["title"] == "Things waiting"
    assert facet["mimeType"] == "application/json"
    assert FACETS_EXTENSION_ID not in (listed["plain"].get("_meta") or {})


async def test_a_read_answers_one_json_text_holding_the_count():
    result = await _call(_probe(count=7), "resources/read", {"uri": "probe://waiting"})

    [content] = result["contents"]
    assert content["mimeType"] == "application/json"
    assert json.loads(content["text"]) == {"count": 7}


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_served_facets_finds_the_marked_resource_on_both_eras(mode: str):
    facets = await served_facets(_probe(count=2), mode)

    assert facets == {
        "things-waiting": {"title": "Things waiting", "level": "critical", "count": 2},
        "unleveled": {"title": "Things unleveled", "level": "warning", "count": 0},
    }


@pytest.mark.parametrize("bad", [-1, 1.5, True, "3", None])
def test_a_count_that_a_host_would_refuse_fails_at_the_server(bad: object):
    with pytest.raises(ValueError, match="non-negative integer"):
        facet_count(bad)  # ty: ignore[invalid-argument-type]


def test_zero_is_a_count():
    assert json.loads(facet_count(0)) == {"count": 0}


def test_a_level_the_extension_does_not_define_fails_at_the_server():
    with pytest.raises(ValueError, match="facet level"):
        facet_meta("urgent")  # ty: ignore[invalid-argument-type]
