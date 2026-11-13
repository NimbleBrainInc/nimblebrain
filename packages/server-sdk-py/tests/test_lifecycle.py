"""Lifecycle handlers as a host meets them on the wire: advertised, listed with their marker.

The host (https://docs.nimblebrain.ai/extensions/lifecycle/) finds the extension in ``server/discover`` and
binds each event to the ``tools/list`` entry whose ``_meta`` carries the identifier. These tests
speak raw JSON-RPC over the ASGI app so what they assert is the bytes a host receives. What a
host would refuse (a required argument, two handlers for one event) is refused at registration.
"""

from __future__ import annotations

from typing import Any

import httpx2
import pytest
from fastmcp import FastMCP

from nimblebrain_server_sdk import (
    CHANGES,
    LIFECYCLE_EXTENSION_ID,
    add_lifecycle_extension,
    lifecycle_meta,
)

HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
MODERN = "2026-07-28"
ENVELOPE = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": {"name": "probe", "version": "0"},
    "io.modelcontextprotocol/clientCapabilities": {},
}


def _probe() -> FastMCP:
    # Tasks on by default, so the test sees that a handler is registered without them.
    probe = FastMCP("probe", tasks=True)
    lifecycle = add_lifecycle_extension(probe)

    @lifecycle.handler("ready", annotations=CHANGES)
    async def scope_ready(reason: str | None = None) -> str:
        return f"ready: {reason}"

    @lifecycle.handler("removing", annotations=CHANGES, meta={"ui": {"visibility": ["app"]}})
    async def scope_removing() -> str:
        return "removing"

    @probe.tool(task=False)
    async def plain() -> str:
        return "plain"

    return probe


async def _call(probe: FastMCP, method: str, params: dict[str, Any] | None = None) -> Any:
    params = params or {}
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": {**params, "_meta": ENVELOPE}}
    headers = {**HEADERS, "mcp-protocol-version": MODERN, "mcp-method": method}
    if "name" in params:
        # 2026-07-28 routes a tool call on the Mcp-Name header, which must match the name.
        headers["mcp-name"] = params["name"]
    app = probe.http_app(json_response=True)
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://p") as http,
    ):
        response = await http.post("/mcp", headers=headers, json=body)
    return response.json()["result"]


async def test_discovery_advertises_the_extension_with_empty_settings():
    capabilities = (await _call(_probe(), "server/discover"))["capabilities"]

    assert capabilities["extensions"][LIFECYCLE_EXTENSION_ID] == {}
    assert "tools" in capabilities


async def test_the_listing_marks_each_handler_with_its_event():
    listed = {t["name"]: t for t in (await _call(_probe(), "tools/list"))["tools"]}

    assert listed["scope_ready"]["_meta"][LIFECYCLE_EXTENSION_ID] == {"event": "ready"}
    assert listed["scope_removing"]["_meta"][LIFECYCLE_EXTENSION_ID] == {"event": "removing"}
    assert LIFECYCLE_EXTENSION_ID not in (listed["plain"].get("_meta") or {})


async def test_a_handler_keeps_the_meta_it_was_given_beside_the_marker():
    listed = {t["name"]: t for t in (await _call(_probe(), "tools/list"))["tools"]}

    assert listed["scope_removing"]["_meta"]["ui"] == {"visibility": ["app"]}


async def test_a_handler_requires_nothing_and_never_offers_tasks():
    # Guards against registering through `server.tool`, which applies the server's task default.
    listed = {t["name"]: t for t in (await _call(_probe(), "tools/list"))["tools"]}

    for name in ("scope_ready", "scope_removing"):
        assert not listed[name]["inputSchema"].get("required"), name
        assert "taskSupport" not in (listed[name].get("execution") or {}), name
    assert "reason" in listed["scope_ready"]["inputSchema"]["properties"]


@pytest.mark.parametrize("arguments", [{"reason": "install"}, {}])
async def test_the_host_call_answers_synchronously(arguments: dict[str, str]):
    result = await _call(_probe(), "tools/call", {"name": "scope_ready", "arguments": arguments})

    assert not result.get("isError")
    assert result["content"][0]["text"] == f"ready: {arguments.get('reason')}"


def test_the_extension_records_which_tool_handles_each_event():
    probe = FastMCP("probe")
    lifecycle = add_lifecycle_extension(probe)

    @lifecycle.handler("removing", name="bye")
    async def scope_removing() -> str:
        return ""

    assert lifecycle.handlers == {"removing": "bye"}


async def test_a_handler_with_a_required_parameter_is_refused_at_registration():
    probe = FastMCP("probe")
    lifecycle = add_lifecycle_extension(probe)

    with pytest.raises(ValueError, match=r"requires \['reason'\]"):

        @lifecycle.handler("ready")
        async def scope_ready(reason: str) -> str:
            return reason

    assert lifecycle.handlers == {}
    assert await probe.list_tools() == []


async def test_a_second_handler_for_one_event_is_refused_at_registration():
    probe = FastMCP("probe")
    lifecycle = add_lifecycle_extension(probe)

    @lifecycle.handler("ready")
    async def scope_ready() -> str:
        return ""

    with pytest.raises(ValueError, match="both handle 'ready'"):

        @lifecycle.handler("ready")
        async def also_ready() -> str:
            return ""

    assert [t.name for t in await probe.list_tools()] == ["scope_ready"]


def test_the_marker_cannot_be_smuggled_through_meta():
    lifecycle = add_lifecycle_extension(FastMCP("probe"))

    with pytest.raises(ValueError, match="comes from the event"):
        lifecycle.handler("ready", meta=lifecycle_meta("removing"))


def test_an_event_the_extension_does_not_define_fails_at_the_server():
    with pytest.raises(ValueError, match="lifecycle event"):
        lifecycle_meta("installed")  # ty: ignore[invalid-argument-type]


def test_the_extension_is_advertised_once():
    probe = FastMCP("probe")
    add_lifecycle_extension(probe)

    with pytest.raises(ValueError, match="already registered"):
        add_lifecycle_extension(probe)
