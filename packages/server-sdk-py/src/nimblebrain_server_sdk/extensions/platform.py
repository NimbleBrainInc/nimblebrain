"""Advertise a platform extension under ``capabilities.extensions``.

An MCP extension (SEP-2133) is a capability a server offers under a reverse-DNS identifier,
negotiated per request and discovered through ``server/discover``. A legacy ``initialize``
never carries the map, so only a 2026-07-28 peer sees an extension.

The set is fixed at construction: FastMCP refuses a registration once the server's lifespan
has started, because a peer that already discovered the map would never see the new entry.
So a bundle advertises its extensions where it builds its ``FastMCP``, before serving.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastmcp import FastMCP
from fastmcp.server.extensions import ServerExtension


class PlatformExtension(ServerExtension):
    """An extension that only advertises: an identifier and its settings, no methods.

    What a platform extension serves rides the primitives a peer already calls (a marked
    resource, a tool), so the advertisement is the whole contract. An extension that serves
    methods of its own subclasses ``ServerExtension`` directly.
    """

    def __init__(self, identifier: str, settings: Mapping[str, Any] | None = None) -> None:
        self.identifier = identifier
        self._settings = dict(settings or {})

    def settings(self) -> dict[str, Any]:
        return dict(self._settings)


def add_platform_extension(
    mcp: FastMCP, identifier: str, settings: Mapping[str, Any] | None = None
) -> PlatformExtension:
    """Advertise ``identifier`` with ``settings`` at ``capabilities.extensions[identifier]``.

    The SDK validates the identifier (a ``vendor-prefix/name`` pair), and FastMCP refuses a
    second registration of the same one and any registration after the server started.
    """
    extension = PlatformExtension(identifier, settings)
    mcp.add_extension(extension)
    return extension
