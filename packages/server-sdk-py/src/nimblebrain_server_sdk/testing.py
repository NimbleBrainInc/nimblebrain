"""Checks a server's tests share: what a host sees of the server, checked as a host would."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any, Literal

from fastmcp import Client, FastMCP
from mcp.types import Request
from pydantic import TypeAdapter

from nimblebrain_server_sdk.extensions.facets import FACET_LEVELS, FACETS_EXTENSION_ID
from nimblebrain_server_sdk.skills import SKILLS_EXTENSION_ID, GetSkillParams, ListSkillsParams


class _ListSkillsRequest(Request[ListSkillsParams, Literal["skills/list"]]):
    method: Literal["skills/list"] = "skills/list"
    params: ListSkillsParams


class _GetSkillRequest(Request[GetSkillParams, Literal["skills/get"]]):
    method: Literal["skills/get"] = "skills/get"
    params: GetSkillParams


_ANY = TypeAdapter(dict[str, Any])


def _digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


async def served_skills(mcp: FastMCP, mode: str = "auto") -> dict[str, dict[str, Any]]:
    """What a host sees of ``mcp``'s skills, checked the way a host checks it.

    Connects in ``mode`` (``"auto"`` negotiates 2026-07-28, ``"legacy"`` 2025-11-25), calls
    ``skills/list``, reads every listed file back through ``resources/read`` and asserts its
    bytes match the listed digest and size, and asserts ``skills/get`` answers each skill with
    its list entry. On 2026-07-28 it also asserts the server declares the extension; a legacy
    handshake carries no extensions. Returns the entries by ``SKILL.md`` URI, for a server's
    tests to compare against the skills it means to publish.
    """
    async with Client(mcp, mode=mode) as client:
        if mode != "legacy":
            extensions = client.server_capabilities.extensions or {}
            assert SKILLS_EXTENSION_ID in extensions, "the skills extension is not declared"
        session = client.session
        listed = await session.send_request(_ListSkillsRequest(params=ListSkillsParams()), _ANY)
        entries = {skill["uri"]: skill for skill in listed["skills"]}
        assert len(entries) == len(listed["skills"]), "skills/list names a skill twice"
        for uri, entry in entries.items():
            for resource in entry["resources"]:
                (content,) = (await session.read_resource(resource["uri"])).contents
                text = getattr(content, "text", None)
                data = (
                    text.encode("utf-8")
                    if text is not None
                    else base64.b64decode(getattr(content, "blob", ""))
                )
                assert _digest(data) == resource["digest"], resource["uri"]
                assert len(data) == resource["size"], resource["uri"]
            got = await session.send_request(_GetSkillRequest(params=GetSkillParams(uri=uri)), _ANY)
            assert got["skill"] == entry, uri
    return entries


async def served_facets(mcp: FastMCP, mode: str = "auto") -> dict[str, dict[str, Any]]:
    """What a host sees of ``mcp``'s facets, checked the way a host checks it.

    Connects in ``mode``, takes the resources whose ``_meta`` carries the facets marker (never
    a URI shape), and asserts each has a ``title``, ``mimeType: application/json`` and a level
    the extension defines, and reads back one JSON text whose ``count`` is an integer at least
    zero. On 2026-07-28 it
    also asserts the server declares the extension; a legacy handshake carries no extensions,
    so there the marked resources are ordinary resources a host ignores. Returns
    ``{name: {"title", "level", "count"}}`` for a server's tests to compare against the facets it
    means to serve.
    """
    facets: dict[str, dict[str, Any]] = {}
    async with Client(mcp, mode=mode) as client:
        if mode != "legacy":
            extensions = client.server_capabilities.extensions or {}
            assert extensions.get(FACETS_EXTENSION_ID) == {}, "the facets extension is not declared"
        for resource in await client.list_resources():
            marker = (resource.meta or {}).get(FACETS_EXTENSION_ID)
            if marker is None:
                continue
            assert isinstance(marker, dict), resource.name
            level = marker.get("level", "warning")
            assert level in FACET_LEVELS, f"{resource.name} has level {level!r}"
            assert resource.title, f"{resource.name} has no title"
            assert resource.mime_type == "application/json", resource.name
            (content,) = await client.read_resource(str(resource.uri))
            assert content.mime_type == "application/json", resource.name
            body = json.loads(getattr(content, "text", ""))
            count = body["count"]
            assert isinstance(count, int) and not isinstance(count, bool), resource.name
            assert count >= 0, resource.name
            assert resource.name not in facets, f"{resource.name} is listed twice"
            facets[resource.name] = {"title": resource.title, "level": level, "count": count}
    return facets


def _texts(value: Any, path: str) -> Iterable[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, Mapping):
        for key, item in value.items():
            yield from _texts(item, f"{path}.{key}")
    elif isinstance(value, list | tuple):
        for i, item in enumerate(value):
            yield from _texts(item, f"{path}[{i}]")


def assert_bounded_rows(
    rows: Iterable[Mapping[str, Any]],
    *,
    unbounded: Iterable[str],
    max_chars: int = 1_000,
) -> None:
    """Assert a listing or search page is bounded and addressed, row by row.

    Each row carries a non-empty ``uri``, none of the ``unbounded`` fields, and no text
    longer than ``max_chars`` anywhere in it (nested values included). Seed every unbounded
    field longer than ``max_chars`` before listing, so a field that leaks under another name
    fails the length check, not only the name check. The default sits above any preview and
    any bounded field a row carries (a title, a URL); a server whose rows hold a longer
    bounded field passes its own. An empty page proves nothing, so it fails.
    """
    rows = list(rows)
    unbounded = set(unbounded)
    assert rows, "an empty page proves nothing about its rows"
    for i, row in enumerate(rows):
        uri = row.get("uri")
        assert isinstance(uri, str) and uri, f"row {i} has no uri"
        leaked = unbounded & row.keys()
        assert not leaked, f"row {i} ({uri}) carries {sorted(leaked)}"
        for path, text in _texts(row, f"row {i}"):
            assert len(text) <= max_chars, f"{path} ({uri}) is {len(text)} characters"
