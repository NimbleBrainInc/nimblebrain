"""The outbox resource over streamable HTTP, on both protocol eras.

A host polls the outbox with ``resources/read`` on the URI the server declared. 2025-11-25
reaches it through an initialized session; 2026-07-28 has no session and routes the read on
the ``Mcp-Name`` header, which must equal the URI, query string included. Both must list the
template and answer a bootstrap and a poll with the same bytes, or a host on one era polls an
outbox the other era serves differently.
"""

from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest
from fastmcp import FastMCP

from nimblebrain_server_sdk.db import secured_session
from nimblebrain_server_sdk.outbox import emit, register_outbox
from tests.outbox.conftest import make_ctx
from tests.test_golden_wire import LEGACY, MODERN, _Peer

RESOURCE = "acme://notifications"
CTX = make_ctx("ws_eras")


async def _poll_over(era: str, engine: Any) -> dict[str, Any]:
    server = FastMCP("outbox-eras")
    register_outbox(server, RESOURCE, lambda ctx: secured_session(engine, ctx), lambda: CTX)
    app = server.http_app()
    async with (
        app.router.lifespan_context(app),
        httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://p") as http,
    ):
        peer = _Peer(http, era)
        await peer.open()
        templates = (await peer.request("resources/templates/list"))["resourceTemplates"]
        bootstrap = await peer.request("resources/read", {"uri": RESOURCE})
        cursor = json.loads(bootstrap["contents"][0]["text"])["cursor"]

        async with secured_session(engine, CTX) as conn:
            await emit(
                conn,
                CTX,
                {
                    "eventId": f"evt_{era}",
                    "name": "domain.active",
                    "timestamp": "2026-01-02T03:04:05Z",
                    "data": {"era": era},
                },
                title="active",
            )
        polled = await peer.request("resources/read", {"uri": f"{RESOURCE}?cursor={cursor}"})
    (template,) = [t for t in templates if t["name"] == "notifications"]
    return {"template": template, "bootstrap": bootstrap, "polled": polled}


@pytest.mark.parametrize("era", [LEGACY, MODERN])
async def test_the_outbox_is_served_on_each_era(engine, era: str) -> None:
    wire = await _poll_over(era, engine)

    assert wire["template"]["uriTemplate"] == f"{RESOURCE}{{?cursor,maxEvents,maxAgeMs}}"
    assert wire["template"]["mimeType"] == "application/json"

    (boot,) = wire["bootstrap"]["contents"]
    assert boot["mimeType"] == "application/json"
    assert json.loads(boot["text"])["events"] == []

    (page,) = wire["polled"]["contents"]
    answer = json.loads(page["text"])
    assert [event["eventId"] for event in answer["events"]] == [f"evt_{era}"]
    assert answer["events"][0]["_meta"] == {
        "ai.nimblebrain/notification": {"level": "info", "title": "active"}
    }
    assert (answer["truncated"], answer["hasMore"]) == (False, False)
