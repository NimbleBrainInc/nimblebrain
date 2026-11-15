"""The request identity a fleet server reads from the headers its edge injects.

A server deployed behind NimbleBrain's edge sidecar holds no token of its own. The edge
verifies the caller's platform token, strips the client ``Authorization`` bearer and every
client-supplied identity header, and injects the verified ``x-tenant-id`` /
``x-workspace-id``. The deployment must admit only the edge to the server, so a caller cannot
forge either one. The server verifies no bearer itself and reads tenant and workspace from
those two headers and nothing else: never a tool argument, never a request body.

Identity fails closed per request. A request without either header did not come through the
edge (or the edge is misconfigured), and :func:`security_context_from_edge_headers` raises
:class:`AuthError` rather than defaulting to a permissive scope. ``AuthError`` is a
:class:`~nimblebrain_server_sdk.errors.ServiceError` with the code ``auth_required``: its
message is safe to show a caller, and the header and deployment it points at are in ``detail``,
which is logged and never sent.

A test has no edge in front of it. ``nimblebrain_server_sdk.db.testing.edge_client`` connects a
client that sends the two headers, the way the edge delivers a request.

Reads are active-workspace-only: ``allowed_workspaces`` is exactly ``{workspace_id}``. The
edge forwards no read grants, so a server never widens the read set on its own.

The function takes the header mapping, so this library stays independent of the MCP
framework. A server passes its framework's request headers::

    from fastmcp.server.dependencies import get_http_headers

    def security_context_from_headers() -> SecurityContext:
        return security_context_from_edge_headers(get_http_headers())
"""

from __future__ import annotations

from collections.abc import Mapping

from nimblebrain_server_sdk.errors import ErrorCode, ServiceError

from .context import SecurityContext

__all__ = [
    "TENANT_HEADER",
    "WORKSPACE_HEADER",
    "AuthError",
    "security_context_from_edge_headers",
]

TENANT_HEADER = "x-tenant-id"
WORKSPACE_HEADER = "x-workspace-id"


class AuthError(ServiceError):
    """Identity could not be established from the edge headers — fail closed.

    Raised when ``x-tenant-id`` or ``x-workspace-id`` is missing or empty; it is never defaulted
    to a permissive scope. It is the ``auth_required`` :class:`ServiceError`: ``message`` is all
    a caller sees, and ``detail`` names the missing header for the operator's logs. A tool
    returns it with ``to_tool_error(exc)``, or the server calls ``add_error_contract(mcp)``
    once and lets it propagate.
    """

    MESSAGE = "This request carries no verified identity, so the server did not run it."

    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.AUTH_REQUIRED, self.MESSAGE, detail=detail)


def security_context_from_edge_headers(
    headers: Mapping[str, str], *, user_header: str | None = None
) -> SecurityContext:
    """The per-request :class:`SecurityContext` from the edge's identity headers.

    Tenant and workspace are stripped of surrounding whitespace; either one missing or empty
    raises :class:`AuthError`, tenant checked first. ``user_header`` names a header to read
    ``user_id`` from, for a server that records one; it is ``None`` when the header is absent
    or empty, and it is never an authorization input.
    """
    tenant_id = (headers.get(TENANT_HEADER) or "").strip()
    workspace_id = (headers.get(WORKSPACE_HEADER) or "").strip()
    user_id = None
    if user_header is not None:
        user_id = (headers.get(user_header) or "").strip() or None

    if not tenant_id:
        raise AuthError(
            f"missing verified tenant identity ({TENANT_HEADER}); "
            "the request did not arrive through the edge"
        )
    if not workspace_id:
        raise AuthError(
            f"missing verified workspace identity ({WORKSPACE_HEADER}); "
            "the request did not arrive through the edge"
        )

    return SecurityContext(
        tenant_id=tenant_id,
        workspace_id=workspace_id,
        # Exactly the active workspace, never a client-controlled value.
        allowed_workspaces=frozenset({workspace_id}),
        user_id=user_id,
    )
