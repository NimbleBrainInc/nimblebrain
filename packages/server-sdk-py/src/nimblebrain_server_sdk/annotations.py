"""What a tool call can change, as the MCP spec's annotation hints say it.

``readOnlyHint`` is how a client tells a read from a write without knowing the tool. Under the
spec's defaults a tool with no annotation reads as a destructive write, so leaving one off
does not leave a tool unclassified: it declares the tool the most dangerous kind. Every tool
a server built on this SDK serves carries one of these. On a server with views, exactly the tools that
are not read-only announce a change.
"""

from __future__ import annotations

from mcp.types import ToolAnnotations

READS = ToolAnnotations(read_only_hint=True)
"""Changes nothing a view shows. A read that records an audit row or refreshes provider state
on the way in is still a read."""

ADDS = ToolAnnotations(read_only_hint=False, destructive_hint=False)
"""A write that loses nothing already there."""

CHANGES = ToolAnnotations(read_only_hint=False, destructive_hint=True)
"""A write that overwrites, removes, or acts on what is already there."""
