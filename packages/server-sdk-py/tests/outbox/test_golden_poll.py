"""Golden: what a host reads back from a poll, as the adapter serves it.

The host keeps the cursor between polls and parses the answer, so both are wire
contracts: a changed key, key order, timestamp form, ``_meta`` block or cursor
shape is a change every polling host sees, and a changed cursor format strands
the cursors hosts already hold.

The scenario is fixed: a bootstrap, two events in their own transactions (one
with every presentation keyword, one with none and a foreign ``_meta`` block),
then a page cut at ``maxEvents=1`` and the page after it. Each answer is the
exact text ``resources/read`` returns, with only the values that vary per run
replaced: each cursor becomes ``<cursor:N>``, N being how many fields it
carries, after checking it decodes under this outbox's epoch and that a
per-event cursor resumes at its own row. What the cursor wire string is for given
fields is pinned by ``test_golden_cursor``.

``tests/golden/poll.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from fastmcp import Client, FastMCP
from sqlalchemy.ext.asyncio import AsyncEngine

from nimblebrain_server_sdk.db import secured_session
from nimblebrain_server_sdk.outbox import emit, register_outbox
from nimblebrain_server_sdk.outbox.cursor import decode
from tests.outbox.conftest import TABLE, make_ctx

GOLDEN = Path(__file__).parent / "golden" / "poll.json"
RESOURCE = "acme://notifications"
CTX = make_ctx("ws_golden")
_CURSOR = re.compile(r'"(nbo1:[A-Za-z0-9_-]+)"')


def _server(engine: AsyncEngine) -> FastMCP:
    server: FastMCP = FastMCP("outbox-golden")
    register_outbox(server, RESOURCE, lambda ctx: secured_session(engine, ctx), lambda: CTX)
    return server


async def _epoch(engine: AsyncEngine) -> str:
    async with secured_session(engine, CTX) as conn:
        state = TABLE.metadata.tables[f"{TABLE.name}_state"]
        return str(await conn.scalar(sa.select(state.c.epoch)))


async def _rows(engine: AsyncEngine) -> dict[str, tuple[int, int]]:
    async with secured_session(engine, CTX) as conn:
        result = await conn.execute(sa.select(TABLE.c.event_id, TABLE.c.txid, TABLE.c.seq))
        return {row.event_id: (row.txid, row.seq) for row in result}


def _normalize(text: str, epoch: str, rows: dict[str, tuple[int, int]]) -> str:
    answer = json.loads(text)
    for event in answer["events"]:
        position = decode(event["cursor"], epoch=epoch)
        assert (position.extra_txid, position.extra_seq) == rows[event["eventId"]]

    def placeholder(match: re.Match[str]) -> str:
        position = decode(match.group(1), epoch=epoch)
        fields = 2 if position.extra_txid is None else 4
        return f'"<cursor:{fields}>"'

    return _CURSOR.sub(placeholder, text)


async def scenario(engine: AsyncEngine) -> dict[str, Any]:
    server = _server(engine)
    async with Client(server) as client:
        (template,) = [
            t for t in await client.list_resource_templates() if t.name == "notifications"
        ]

        async def poll(query: str = "") -> str:
            contents = await client.read_resource(RESOURCE + query)
            return contents[0].text

        bootstrap = await poll()
        cursor = json.loads(bootstrap)["cursor"]

        async with secured_session(engine, CTX) as conn:
            await emit(
                conn,
                CTX,
                {
                    "eventId": "evt_1",
                    "name": "domain.active",
                    "timestamp": "2026-01-02T03:04:05+10:00",
                    "data": {"domain": "example.com", "n": 1},
                },
                title="example.com is active",
                level="attention",
                subject="example.com",
                body="DNS propagated.",
                link_resource="acme://domains/1",
            )
        async with secured_session(engine, CTX) as conn:
            await emit(
                conn,
                CTX,
                {
                    "eventId": "evt_2",
                    "name": "reply.received",
                    "timestamp": "2026-01-02T03:04:05.250000Z",
                    "data": {},
                    "_meta": {"com.example/other": {"k": [1, "two"]}},
                },
            )

        first = await poll(f"?cursor={cursor}&maxEvents=1")
        second = await poll(f"?cursor={json.loads(first)['cursor']}")
        caught_up = await poll(f"?cursor={json.loads(second)['cursor']}")

    epoch = await _epoch(engine)
    rows = await _rows(engine)
    return {
        "template": {
            "uriTemplate": template.uri_template,
            "name": template.name,
            "mimeType": template.mime_type,
            "description": template.description,
        },
        "bootstrap": _normalize(bootstrap, epoch, rows),
        "page_cut_at_max_events": _normalize(first, epoch, rows),
        "page_after": _normalize(second, epoch, rows),
        "caught_up": _normalize(caught_up, epoch, rows),
    }


async def test_poll_answers_match_golden(engine) -> None:
    assert await scenario(engine) == json.loads(GOLDEN.read_text())
