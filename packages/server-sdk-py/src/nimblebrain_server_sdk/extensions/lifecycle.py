"""Serve lifecycle handlers: the tools a host calls when it installs and removes this server.

``ai.nimblebrain/lifecycle`` tells a server that a host made it available to a scope
(``ready``) and that the host is about to take it away (``removing``). The extension adds no
method. A server advertises the identifier and marks one tool per event with
``_meta["ai.nimblebrain/lifecycle"]: {"event": ...}``. The host calls that tool as a plain
``tools/call``, with ``{"reason": "install" | "resume"}`` to a ``ready`` handler that declares
``reason``, and with ``{}`` otherwise. The specification is
https://docs.nimblebrain.ai/extensions/lifecycle/.

A bundle advertises the extension and marks its handlers where it builds its server::

    lifecycle = add_lifecycle_extension(mcp)

    @lifecycle.handler("ready", annotations=CHANGES)
    async def workspace_ready(reason: str | None = None) -> str: ...

    @lifecycle.handler("removing", annotations=CHANGES)
    async def workspace_removing() -> str: ...

Registering through the extension refuses, at import, what a host would refuse at install:
a handler whose input schema requires a property (spec §3), and a second handler for one event,
which a host treats as no handler at all. It also registers each handler without task support,
because the host calls synchronously and the NimbleBrain host refuses a handler that offers
tasks. A tool marked by hand with ``meta=lifecycle_meta(...)`` gets none of these checks.

**Handlers stay listed to every client.** The spec (§6) says a server SHOULD NOT list its
handlers to a client that did not advertise the extension, and FastMCP 4 could do that without
patching it: a ``Middleware.on_list_tools`` reading ``Context.client_extension_settings``. This
library does not, by default or as an option. A host that reads the declaration from its
operator catalog rather than from the wire finds each handler by name in ``tools/list`` and
advertises nothing, so withholding would break that host's lifecycle calls for as long as it
reads the catalog. What makes listing safe is the server's own duty (spec §5): every handler is
safe for any caller holding the scope's identity, so ``removing`` records intent and never
destroys. Revisit once no host reads ``lifecycle`` from a catalog.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, TypeVar

from fastmcp import FastMCP
from fastmcp.tools import FunctionTool
from mcp_types import ToolAnnotations

from nimblebrain_server_sdk.extensions.platform import PlatformExtension

LIFECYCLE_EXTENSION_ID = "ai.nimblebrain/lifecycle"

LifecycleEvent = Literal["ready", "removing"]
#: The two moments a host can reach the server: it has been made available to the scope,
#: and it is about to be removed from it.
LIFECYCLE_EVENTS: tuple[LifecycleEvent, ...] = ("ready", "removing")

F = TypeVar("F", bound=Callable[..., Any])


def lifecycle_meta(event: LifecycleEvent) -> dict[str, Any]:
    """The ``_meta`` a handler tool carries: the extension's marker, naming its event.

    Raises :class:`ValueError` for an event the extension does not define, which a host
    ignores, so the handler would never be called.
    """
    if event not in LIFECYCLE_EVENTS:
        raise ValueError(f"a lifecycle event is one of {LIFECYCLE_EVENTS}, not {event!r}")
    return {LIFECYCLE_EXTENSION_ID: {"event": event}}


class LifecycleExtension(PlatformExtension):
    """The advertised extension, and the record of which tool handles which event."""

    def __init__(self) -> None:
        super().__init__(LIFECYCLE_EXTENSION_ID)
        self._handlers: dict[LifecycleEvent, str] = {}

    @property
    def handlers(self) -> dict[LifecycleEvent, str]:
        """The tool registered for each event, by event."""
        return dict(self._handlers)

    def handler(
        self,
        event: LifecycleEvent,
        *,
        name: str | None = None,
        title: str | None = None,
        description: str | None = None,
        annotations: ToolAnnotations | None = None,
        meta: dict[str, Any] | None = None,
    ) -> Callable[[F], F]:
        """Register the decorated function as this server's handler for ``event``.

        The tool is an ordinary tool carrying :func:`lifecycle_meta` merged into ``meta``.
        Raises :class:`ValueError`, before anything is registered, for a second handler for
        ``event``, for a handler whose input schema requires a property, and for a ``meta``
        that already carries the marker.
        """
        marker = lifecycle_meta(event)
        if LIFECYCLE_EXTENSION_ID in (meta or {}):
            raise ValueError(
                f"the {LIFECYCLE_EXTENSION_ID} marker comes from the event, not from meta"
            )

        def register(fn: F) -> F:
            tool = FunctionTool.from_function(
                fn,
                name=name,
                title=title,
                description=description,
                annotations=annotations,
                meta={**(meta or {}), **marker},
                task=False,
            )
            if event in self._handlers:
                raise ValueError(
                    f"{tool.name!r} and {self._handlers[event]!r} both handle {event!r}; a host "
                    "treats an event with two handlers as having none"
                )
            required = tool.parameters.get("required") or []
            if required:
                raise ValueError(
                    f"lifecycle handler {tool.name!r} requires {sorted(required)}; a host calls "
                    "it with no required arguments, so give each parameter a default"
                )
            self.server.add_tool(tool)
            self._handlers[event] = tool.name
            return fn

        return register


def add_lifecycle_extension(mcp: FastMCP) -> LifecycleExtension:
    """Advertise ``ai.nimblebrain/lifecycle`` on ``mcp`` and return it, to register handlers on.

    Like any platform extension it is advertised in ``server/discover`` only, so a host on a
    2025-era connection sees no extension and makes no lifecycle calls (spec §2, §6).
    """
    extension = LifecycleExtension()
    mcp.add_extension(extension)
    return extension
