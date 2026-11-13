"""Edge-header identity: tenant and workspace from the edge's headers only, fail-closed."""

from __future__ import annotations

import pytest

from nimblebrain_server_sdk.db import (
    TENANT_HEADER,
    WORKSPACE_HEADER,
    AuthError,
    SecurityContext,
    security_context_from_edge_headers,
)


def test_headers_are_the_edge_names() -> None:
    assert TENANT_HEADER == "x-tenant-id"
    assert WORKSPACE_HEADER == "x-workspace-id"


def test_context_is_active_workspace_only() -> None:
    ctx = security_context_from_edge_headers(
        {"x-tenant-id": " t1 ", "x-workspace-id": " ws_a ", "x-allowed-workspaces": "ws_b"}
    )
    assert ctx == SecurityContext(
        tenant_id="t1", workspace_id="ws_a", allowed_workspaces=frozenset({"ws_a"})
    )


@pytest.mark.parametrize(
    ("headers", "message"),
    [
        ({}, "missing verified tenant identity (x-tenant-id)"),
        ({"x-workspace-id": "ws_a"}, "missing verified tenant identity (x-tenant-id)"),
        ({"x-tenant-id": "  ", "x-workspace-id": "ws_a"}, "missing verified tenant identity"),
        ({"x-tenant-id": "t1"}, "missing verified workspace identity (x-workspace-id)"),
        ({"x-tenant-id": "t1", "x-workspace-id": ""}, "missing verified workspace identity"),
    ],
)
def test_missing_identity_fails_closed(headers: dict[str, str], message: str) -> None:
    with pytest.raises(AuthError, match=message.replace("(", r"\(").replace(")", r"\)")) as err:
        security_context_from_edge_headers(headers)
    assert str(err.value).endswith("; the request did not arrive through the mcp-edge sidecar")


def test_user_id_is_read_only_when_asked() -> None:
    headers = {"x-tenant-id": "t1", "x-workspace-id": "ws_a", "x-user-id": " u1 "}
    assert security_context_from_edge_headers(headers).user_id is None
    assert security_context_from_edge_headers(headers, user_header="x-user-id").user_id == "u1"
    del headers["x-user-id"]
    assert security_context_from_edge_headers(headers, user_header="x-user-id").user_id is None


def test_identity_columns_are_the_active_workspace() -> None:
    ctx = SecurityContext(
        tenant_id="t1", workspace_id="ws_a", allowed_workspaces=frozenset({"ws_a", "ws_b"})
    )
    assert ctx.identity_columns() == {"tenant_id": "t1", "workspace_id": "ws_a"}
