"""Serve facets: how many things are waiting in this server (``ai.nimblebrain/facets``).

A facet is one countable obligation, such as drafts awaiting review. The extension adds no
method. A server advertises the identifier, lists each facet as a resource whose ``_meta``
carries the identifier (holding the facet's urgency level) and whose ``title`` is the label a
host renders after the count, and answers ``resources/read`` with ``{"count": n}``. The
specification is https://docs.nimblebrain.ai/extensions/facets/.

A bundle registers a facet where it builds its server::

    add_platform_extension(mcp, FACETS_EXTENSION_ID)

    @mcp.resource(
        "acme://facets/blocked",
        name="tickets-blocked",
        title="Tickets blocked",
        mime_type="application/json",
        meta=facet_meta("critical"),
    )
    async def tickets_blocked() -> str:
        return facet_count(await count_blocked())

The read takes no arguments: it counts for the identity the transport established, with the
same session and identity function the server's tools use.
"""

from __future__ import annotations

import json
from typing import Any, Literal

FACETS_EXTENSION_ID = "ai.nimblebrain/facets"

FacetLevel = Literal["critical", "warning", "info"]
#: How urgent a non-zero count is, most urgent first: something has stopped, someone should
#: act, worth knowing. A host orders by it and shows it; one that sees none reads ``warning``.
FACET_LEVELS: tuple[FacetLevel, ...] = ("critical", "warning", "info")


def facet_meta(level: FacetLevel) -> dict[str, Any]:
    """The ``_meta`` a facet resource carries: the extension's marker, holding its level.

    The level belongs to the facet, not to a reading, so it is declared once here and never
    changes with the count. Raises :class:`ValueError` for a level the extension does not
    define, which a host would read as ``warning``.
    """
    if level not in FACET_LEVELS:
        raise ValueError(f"a facet level is one of {FACET_LEVELS}, not {level!r}")
    return {FACETS_EXTENSION_ID: {"level": level}}


def facet_count(count: int) -> str:
    """The body of a facet read: ``{"count": count}`` as JSON text.

    Raises :class:`ValueError` for anything but a non-negative integer, because a host treats
    any other count as a failed read. Failing here names the server's own bug instead of
    leaving it to show up as a facet that never renders.
    """
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ValueError(f"a facet count is a non-negative integer, not {count!r}")
    return json.dumps({"count": count})
