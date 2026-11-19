"""The Server Card: where it is served, what it carries, and what it refuses.

``fixtures/server_card.json`` is shared with the runtime's reader: this suite asserts the probe
server below serves exactly its ``card`` at its ``card_path`` with its ``media_type``, and the
runtime's unit suite parses that same ``card`` and asserts it reads ``host_reads``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx2
import mcp.types as mt
import pytest
from fastmcp import Client, FastMCP
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from mcp.types import Icon

import nimblebrain_server_sdk as sdk
from nimblebrain_server_sdk.testing import Mode

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "server_card.json").read_text())
CARD = FIXTURE["card"]


def _probe(name: str = CARD["name"], **card: Any) -> FastMCP:
    mcp = FastMCP(
        name,
        version=CARD["version"],
        website_url=CARD["websiteUrl"],
        icons=[Icon.model_validate(icon) for icon in CARD["icons"]],
    )
    sdk.add_server_card(
        mcp,
        **(
            card
            or {
                "title": CARD["title"],
                "description": CARD["description"],
                "placements": CARD["_meta"][sdk.HOST_META_KEY]["placements"],
            }
        ),
    )
    return mcp


@asynccontextmanager
async def _http(app: Any) -> AsyncIterator[httpx2.AsyncClient]:
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as http:
        yield http


async def test_the_card_is_the_fixture_served_where_the_runtime_reads_it() -> None:
    async with _http(_probe().http_app()) as http:
        response = await http.get(FIXTURE["card_path"], headers={"accept": FIXTURE["media_type"]})
    assert response.status_code == 200
    assert response.headers["content-type"] == FIXTURE["media_type"] == sdk.SERVER_CARD_MEDIA_TYPE
    assert response.json() == CARD
    assert CARD["$schema"] == sdk.SERVER_CARD_SCHEMA


def test_add_server_card_returns_the_card_it_serves() -> None:
    mcp = FastMCP("com.example/bare", version="1.0.0")
    card = sdk.add_server_card(mcp, description="Does one thing.")
    assert card == {
        "$schema": sdk.SERVER_CARD_SCHEMA,
        "name": "com.example/bare",
        "version": "1.0.0",
        "description": "Does one thing.",
    }


@pytest.mark.parametrize(
    ("path", "served", "unserved"),
    [
        ("/api/mcp/", "/api/mcp/server-card", "/mcp/server-card"),
        ("/", "/server-card", "/mcp/server-card"),
        ("/mcp", "/mcp/server-card", "/other/server-card"),
    ],
)
async def test_the_card_follows_the_mcp_path(path: str, served: str, unserved: str) -> None:
    async with _http(_probe().http_app(path=path)) as http:
        assert (await http.get(served)).status_code == 200
        assert (await http.get(unserved)).status_code == 404


async def test_the_card_is_read_only_public_and_cacheable() -> None:
    async with _http(_probe().http_app()) as http:
        first = await http.get("/mcp/server-card")
        etag = first.headers["etag"]
        assert first.headers["access-control-allow-origin"] == "*"
        assert first.headers["access-control-allow-methods"] == "GET"
        assert first.headers["access-control-expose-headers"] == "ETag"
        assert first.headers["cache-control"] == "public, max-age=3600"
        again = await http.get("/mcp/server-card", headers={"if-none-match": f"W/{etag}"})
        assert again.status_code == 304
        assert again.content == b""
        stale = await http.get("/mcp/server-card", headers={"if-none-match": '"other"'})
        assert stale.status_code == 200
        assert (await http.post("/mcp/server-card", json={})).status_code == 405


async def test_the_card_needs_no_authentication() -> None:
    from fastmcp.server.auth.providers.jwt import StaticTokenVerifier

    mcp = _probe()
    mcp.auth = StaticTokenVerifier(tokens={"secret": {"client_id": "c", "scopes": []}})
    async with _http(mcp.http_app()) as http:
        assert (await http.post("/mcp", json={})).status_code == 401
        assert (await http.get("/mcp/server-card")).status_code == 200


async def test_the_sse_transport_serves_no_card() -> None:
    async with _http(_probe().http_app(transport="sse")) as http:
        assert (await http.get("/sse/server-card")).status_code == 404
        assert (await http.get("/server-card")).status_code == 404


async def test_nothing_of_the_card_is_served_over_mcp() -> None:
    """Over stdio a server has only the MCP session: the card adds no tool, resource or prompt."""
    bare = FastMCP(CARD["name"], version=CARD["version"])
    carded = _probe()
    seen = []
    for mcp in (bare, carded):
        async with Client(mcp) as client:
            seen.append(
                (
                    await client.list_tools(),
                    await client.list_resources(),
                    await client.list_resource_templates(),
                    await client.list_prompts(),
                )
            )
    assert seen[0] == seen[1]


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_the_handshake_reports_the_cards_title(mode: Mode) -> None:
    mcp = _probe()
    async with Client(mcp, mode=mode) as client:
        info = client.server_info
    assert info is not None
    assert (info.name, info.title) == (CARD["name"], CARD["title"])
    async with _http(mcp.http_app()) as http:
        assert (await http.get(FIXTURE["card_path"])).json() == CARD


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_a_title_the_server_reports_itself_is_kept(mode: Mode) -> None:
    class OwnTitle(Middleware):
        async def on_initialize(
            self,
            context: MiddlewareContext[mt.InitializeRequest],
            call_next: CallNext[mt.InitializeRequest, mt.InitializeResult | None],
        ) -> mt.InitializeResult | None:
            result = await call_next(context)
            assert result is not None
            info = result.server_info.model_copy(update={"title": "Own"})
            return result.model_copy(update={"server_info": info})

        async def on_discover(
            self,
            context: MiddlewareContext[mt.DiscoverRequest],
            call_next: CallNext[mt.DiscoverRequest, mt.DiscoverResult | dict[str, Any]],
        ) -> mt.DiscoverResult | dict[str, Any]:
            result = await call_next(context)
            assert isinstance(result, mt.DiscoverResult)
            meta = result.meta or {}
            stamp = {**meta.get(mt.SERVER_INFO_META_KEY, {}), "title": "Own"}
            return result.model_copy(update={"meta": {**meta, mt.SERVER_INFO_META_KEY: stamp}})

    mcp = _probe()
    mcp.add_middleware(OwnTitle())
    async with Client(mcp, mode=mode) as client:
        assert client.server_info is not None
        assert client.server_info.title == "Own"


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_without_a_title_the_handshake_has_none(mode: Mode) -> None:
    mcp = FastMCP("com.example/plain", version="1.0.0")
    sdk.add_server_card(mcp, description="Plain.")
    async with Client(mcp, mode=mode) as client:
        assert client.server_info is not None
        assert client.server_info.title is None


def test_without_placements_there_is_no_meta_and_no_title_unless_given() -> None:
    card = sdk.add_server_card(FastMCP("com.example/plain", version="1"), description="Plain.")
    assert "_meta" not in card
    assert "title" not in card
    assert "icons" not in card
    assert "websiteUrl" not in card
    assert "remotes" not in card


@pytest.mark.parametrize(
    ("name", "card"),
    [
        ("notes", {"description": "ok"}),
        ("com.example/a/b", {"description": "ok"}),
        ("com.example/notes", {"description": " "}),
        ("com.example/notes", {"description": "x" * 101}),
        ("com.example/notes", {"description": "ok", "title": ""}),
        ("com.example/notes", {"description": "ok", "placements": [{"slot": "main"}]}),
        (
            "com.example/notes",
            {"description": "ok", "placements": [{"slot": "main", "resourceUri": "ui://board"}]},
        ),
        (
            "com.example/notes",
            {"description": "ok", "placements": [{"slot": "main", "resourceUri": "https://x/y"}]},
        ),
        (
            "com.example/notes",
            {"description": "ok", "placements": [{"slot": "", "resourceUri": "ui://a/b"}]},
        ),
        (
            "com.example/notes",
            {"description": "ok", "placements": [{"slot": "main", "resourceUri": "ui://a/../b"}]},
        ),
        (
            "com.example/notes",
            {
                "description": "ok",
                "placements": [
                    {"slot": "main", "resourceUri": "ui://a/b"},
                    {"slot": "settings", "resourceUri": "ui://other/c"},
                ],
            },
        ),
        (
            "com.example/notes",
            {
                "description": "ok",
                "placements": [{"slot": "main", "resourceUri": "ui://a/b", "resource_uri": "x"}],
            },
        ),
        (
            "com.example/notes",
            {
                "description": "ok",
                "placements": [{"slot": "main", "resourceUri": "ui://a/b", "size": "huge"}],
            },
        ),
    ],
)
def test_a_card_a_reader_would_refuse_is_refused_at_import(name: str, card: Any) -> None:
    mcp = FastMCP(name, version="1.0.0")
    with pytest.raises(ValueError):  # noqa: PT011
        sdk.add_server_card(mcp, **card)
    # Nothing was registered: a corrected card still serves.
    sdk.add_server_card(FastMCP("com.example/fixed", version="1.0.0"), description="ok")


@pytest.mark.parametrize("version", ["^1.2.3", "1.x", ">=1.0", "1.*"])
def test_a_version_range_is_refused(version: str) -> None:
    with pytest.raises(ValueError, match="one exact version"):
        sdk.add_server_card(FastMCP("com.example/notes", version=version), description="ok")


def test_a_server_serves_one_card() -> None:
    mcp = FastMCP("com.example/notes", version="1.0.0")
    sdk.add_server_card(mcp, description="ok")
    with pytest.raises(ValueError, match="already serves"):
        sdk.add_server_card(mcp, description="again")
