"""Serve an MCP Server Card: what a host reads about this server before it connects.

A Server Card (SEP-2127, extension ``io.modelcontextprotocol/server-card``) is a JSON document
that names and describes one MCP server. A server on streamable HTTP serves it at
``GET <streamable-http-url>/server-card`` with the media type
``application/mcp-server-card+json``, so a server at ``http://127.0.0.1:8000/mcp`` serves it at
``/mcp/server-card``. NimbleBrain reads it when a server is added by URL: the card's ``title``,
``description`` and ``icons`` name the connector, and the ``placements`` in its
``_meta["ai.nimblebrain/host"]`` block put its views in the shell.

The card is built from what the server already declares, so it cannot drift from it::

    mcp = FastMCP("com.example/notes", version="1.2.0", website_url="https://example.com")
    add_server_card(
        mcp,
        title="Notes",
        description="Saves and reads short notes.",
        placements=[{"slot": "sidebar.apps", "resourceUri": "ui://notes/board"}],
    )

``name``, ``version``, ``websiteUrl`` and ``icons`` are the server's own, the values its
``serverInfo`` reports. FastMCP has no place for a title or description, so those and the
placements are declared here, once. The title also becomes the handshake's ``serverInfo.title``,
so a client that reads only the live connection shows it rather than the reverse-DNS name.

The card carries no ``remotes``: a server cannot know reliably the URL its clients reach it at
(it binds ``0.0.0.0``, sits behind a proxy, or is reached through a container's host alias), and
a reader that fetched the card already has that URL. The card holds only public metadata: no
credential, no per-user data, and no request ever changes it.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Sequence
from typing import Any, Literal, NotRequired, Required, TypedDict
from weakref import WeakKeyDictionary

import mcp.types as mt
from fastmcp import FastMCP
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from starlette.requests import Request
from starlette.responses import Response

__all__ = [
    "HOST_META_KEY",
    "SERVER_CARD_MEDIA_TYPE",
    "SERVER_CARD_SCHEMA",
    "Placement",
    "add_server_card",
]

#: The media type a card is served with, and the one a reader sends as ``Accept``.
SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json"

#: The JSON Schema a card names in ``$schema``, which the Server Card schema requires.
SERVER_CARD_SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"

#: The ``_meta`` key of NimbleBrain's host block, the same block a catalog entry carries.
HOST_META_KEY = "ai.nimblebrain/host"

#: The host block's contract version. A host accepts any ``1.x``.
_HOST_VERSION = "1.0"

#: The card's path under the server's streamable-HTTP path.
_CARD_SUFFIX = "/server-card"

# The Server Card schema's limits, which a reader may enforce by refusing the card.
_NAME = re.compile(r"[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+")
_NAME_LENGTH = (3, 200)
_TEXT_MAX = 100
_VERSION_MAX = 255
_VERSION_RANGE = re.compile(r"^[\^~<>=]|(^|\.)[xX*](\.|$)")

_UI_URI = re.compile(r"ui://([^/]+)/(.+)")
_SIZES = ("compact", "full", "auto")


class Placement(TypedDict):
    """Where a view this server serves appears in the NimbleBrain shell.

    The keys are the wire's, as a catalog entry's ``placements`` writes them. ``slot`` is the
    shell slot (``"sidebar.apps"``, ``"main"``, ``"settings"``, ...) and ``resourceUri`` the
    ``ui://<authority>/<path>`` resource this server serves there. ``priority`` orders entries
    within a slot (lower first), ``label`` names a sidebar entry, ``icon`` is a Lucide icon name
    for a ``sidebar.bottom`` entry, ``route`` registers the view at ``/app/<route>``, and
    ``size`` is a hint the shell does not read.
    """

    slot: Required[str]
    resourceUri: Required[str]
    priority: NotRequired[int]
    label: NotRequired[str]
    icon: NotRequired[str]
    route: NotRequired[str]
    size: NotRequired[Literal["compact", "full", "auto"]]


_PLACEMENT_KEYS = frozenset(Placement.__annotations__)

# The servers a card is registered on: a second registration would add a route FastMCP never
# reaches, which would leave the second call's card silently unserved.
_REGISTERED: WeakKeyDictionary[FastMCP[Any], dict[str, Any]] = WeakKeyDictionary()


def add_server_card(
    mcp: FastMCP[Any],
    *,
    description: str,
    title: str | None = None,
    placements: Sequence[Placement] = (),
) -> dict[str, Any]:
    """Serve ``mcp``'s Server Card at ``<streamable-http-path>/server-card``, and return it.

    ``name``, ``version``, ``websiteUrl`` and ``icons`` come from ``mcp``; ``description``
    (what the server does, for a person choosing it) and ``title`` (its display name) are
    declared here, since FastMCP has no place for them. ``placements`` become the card's
    ``_meta["ai.nimblebrain/host"]`` block; with none, the card has no ``_meta``.

    ``title`` is also the server's ``serverInfo.title``: in the ``initialize`` result, and in
    the ``serverInfo`` stamp of the ``server/discover`` result on 2026-07-28. A title the server
    already reports there (set by its own middleware) is kept.

    The route answers ``GET`` on the streamable-HTTP transport only, with no authentication,
    so a host can read the card before it connects. It sends the CORS and caching headers the
    Server Card discovery rules ask for and honours ``If-None-Match``. Over stdio, or on the
    SSE transport, nothing is served.

    Raises :class:`ValueError`, before anything is registered, for what a reader would refuse:
    a server name that is not reverse-DNS (``FastMCP("com.example/notes")``), a description or
    title that is empty or over 100 characters, a version range, a placement whose
    ``resourceUri`` is not ``ui://<authority>/<path>`` or whose authority differs from the
    first one's, an unknown placement key, and a second card on one server.
    """
    if mcp in _REGISTERED:
        raise ValueError(f"{mcp.name!r} already serves a Server Card")
    card = _build_card(mcp, description=description, title=title, placements=placements)
    body = json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode()
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
        "Access-Control-Expose-Headers": "ETag",
        "Cache-Control": "public, max-age=3600",
        "ETag": etag,
    }

    async def serve_card(request: Request) -> Response:
        state = request.app.state
        if getattr(state, "transport_type", None) != "streamable-http":
            return Response(status_code=404)
        under = request.path_params.get("mcp_path")
        served_at = "" if under is None else f"/{under}"
        if served_at != str(getattr(state, "path", "")).rstrip("/"):
            return Response(status_code=404)
        if etag in _etags(request.headers.get("if-none-match")):
            return Response(status_code=304, headers=headers)
        return Response(body, media_type=SERVER_CARD_MEDIA_TYPE, headers=headers)

    # Two routes, because a path parameter cannot be empty: one for an MCP path at the root.
    mcp.custom_route("/{mcp_path:path}" + _CARD_SUFFIX, methods=["GET"])(serve_card)
    mcp.custom_route(_CARD_SUFFIX, methods=["GET"])(serve_card)
    if title is not None:
        mcp.add_middleware(_HandshakeTitle(title))
    _REGISTERED[mcp] = card
    return json.loads(body)


class _HandshakeTitle(Middleware):
    """Report the card's title as ``serverInfo.title``, where a client that reads only the
    handshake looks for a display name. A title already there is the server's own and is kept.

    Every 2026-07-28 result carries a ``serverInfo`` stamp in ``_meta``; a client reads its
    identity from the ``server/discover`` one, the only one a FastMCP middleware can reach.
    """

    def __init__(self, title: str) -> None:
        self._title = title

    async def on_initialize(
        self,
        context: MiddlewareContext[mt.InitializeRequest],
        call_next: CallNext[mt.InitializeRequest, mt.InitializeResult | None],
    ) -> mt.InitializeResult | None:
        result = await call_next(context)
        if result is None or result.server_info.title is not None:
            return result
        info = result.server_info.model_copy(update={"title": self._title})
        return result.model_copy(update={"server_info": info})

    async def on_discover(
        self,
        context: MiddlewareContext[mt.DiscoverRequest],
        call_next: CallNext[mt.DiscoverRequest, mt.DiscoverResult | dict[str, Any]],
    ) -> mt.DiscoverResult | dict[str, Any]:
        result = await call_next(context)
        if not isinstance(result, mt.DiscoverResult):
            return result
        meta = result.meta or {}
        stamp = meta.get(mt.SERVER_INFO_META_KEY)
        if not isinstance(stamp, dict) or stamp.get("title") is not None:
            return result
        stamped = {**meta, mt.SERVER_INFO_META_KEY: {**stamp, "title": self._title}}
        return result.model_copy(update={"meta": stamped})


def _etags(header: str | None) -> set[str]:
    if not header:
        return set()
    return {tag.strip().removeprefix("W/") for tag in header.split(",")}


def _build_card(
    mcp: FastMCP[Any],
    *,
    description: str,
    title: str | None,
    placements: Sequence[Placement],
) -> dict[str, Any]:
    name = mcp.name
    low, high = _NAME_LENGTH
    if not _NAME.fullmatch(name) or not low <= len(name) <= high:
        raise ValueError(
            f"a Server Card names its server in reverse-DNS form with one slash "
            f"(FastMCP('com.example/notes')), not {name!r}"
        )
    version = mcp.version
    if not version or len(version) > _VERSION_MAX or _VERSION_RANGE.search(version):
        raise ValueError(f"a Server Card's version is one exact version, not {version!r}")
    card: dict[str, Any] = {
        "$schema": SERVER_CARD_SCHEMA,
        "name": name,
        "version": version,
        "description": _text("description", description),
    }
    if title is not None:
        card["title"] = _text("title", title)
    if mcp.website_url:
        card["websiteUrl"] = mcp.website_url
    icons = [icon.model_dump(by_alias=True, mode="json", exclude_none=True) for icon in mcp.icons]
    if icons:
        card["icons"] = icons
    if placements:
        card["_meta"] = {
            HOST_META_KEY: {
                "host_version": _HOST_VERSION,
                "placements": _checked_placements(placements),
            }
        }
    return card


def _text(field: str, value: str) -> str:
    if not value.strip() or len(value) > _TEXT_MAX:
        raise ValueError(
            f"a Server Card's {field} is 1 to {_TEXT_MAX} characters, not {len(value)}: {value!r}"
        )
    return value


def _checked_placements(placements: Sequence[Placement]) -> list[dict[str, Any]]:
    """The placements as the host keeps them, refusing any the host would drop."""
    authority: str | None = None
    out: list[dict[str, Any]] = []
    for placement in placements:
        unknown = set(placement) - _PLACEMENT_KEYS
        if unknown:
            raise ValueError(
                f"a placement has no {sorted(unknown)}; its keys are {sorted(_PLACEMENT_KEYS)}"
            )
        slot = placement.get("slot")
        if not isinstance(slot, str) or not slot.strip():
            raise ValueError(f"a placement's slot is a non-empty string, not {slot!r}")
        uri = placement.get("resourceUri")
        match = _UI_URI.fullmatch(uri) if isinstance(uri, str) else None
        if match is None or ".." in match[2]:
            raise ValueError(f"a placement's resourceUri is ui://<authority>/<path>, not {uri!r}")
        if authority is None:
            authority = match[1]
        elif match[1] != authority:
            raise ValueError(
                f"every placement shares one ui:// authority; {uri!r} is not under "
                f"ui://{authority}/, and a host drops it"
            )
        size = placement.get("size")
        if size is not None and size not in _SIZES:
            raise ValueError(f"a placement's size is one of {_SIZES}, not {size!r}")
        out.append(dict(placement))
    return out
