"""A server's tests reach its tools with a verified identity, and without one are refused."""

from __future__ import annotations

import pytest
from fastmcp import Client, FastMCP
from fastmcp.server.dependencies import get_http_headers

from nimblebrain_server_sdk import READS, add_error_contract
from nimblebrain_server_sdk.db import AuthError, security_context_from_edge_headers
from nimblebrain_server_sdk.db.testing import edge_client
from nimblebrain_server_sdk.testing import Mode

MODES: tuple[Mode, ...] = ("auto", "legacy")


def server(*, contract: bool = True) -> FastMCP:
    mcp = FastMCP("identity")
    if contract:
        add_error_contract(mcp)

    @mcp.tool(annotations=READS)
    async def who(tenant_id: str | None = None, workspace_id: str | None = None) -> dict:
        """Report the identity the call runs under. The arguments are bait: never read."""
        ctx = security_context_from_edge_headers(get_http_headers(), user_header="x-user-id")
        return {"tenant": ctx.tenant_id, "workspace": ctx.workspace_id, "user": ctx.user_id}

    return mcp


@pytest.mark.parametrize("mode", MODES)
async def test_edge_client_supplies_the_identity(mode: Mode) -> None:
    async with edge_client(server(), tenant_id="t1", workspace_id="ws_a", mode=mode) as client:
        result = await client.call_tool("who", {})
    assert result.structured_content == {"tenant": "t1", "workspace": "ws_a", "user": None}


async def test_edge_client_sends_other_headers_but_never_overrides_the_identity() -> None:
    headers = {"x-user-id": "u1", "x-tenant-id": "forged", "x-workspace-id": "forged"}
    async with edge_client(
        server(), tenant_id="t1", workspace_id="ws_a", headers=headers
    ) as client:
        result = await client.call_tool("who", {})
    assert result.structured_content == {"tenant": "t1", "workspace": "ws_a", "user": "u1"}


async def test_identity_never_comes_from_a_tool_argument() -> None:
    """With the helper in use, an argument still cannot name the tenant or workspace."""
    forged = {"tenant_id": "t2", "workspace_id": "ws_b"}
    async with edge_client(server(), tenant_id="t1", workspace_id="ws_a") as client:
        result = await client.call_tool("who", forged)
    assert result.structured_content == {"tenant": "t1", "workspace": "ws_a", "user": None}
    async with Client(server()) as client:
        refused = await client.call_tool("who", forged, raise_on_error=False)
    assert refused.is_error


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("contract", [True, False])
async def test_without_identity_the_caller_sees_nothing_of_the_deployment(
    mode: Mode, contract: bool
) -> None:
    """The in-memory client sends no headers. What comes back names no header and no edge."""
    async with Client(server(contract=contract), mode=mode) as client:
        result = await client.call_tool("who", {}, raise_on_error=False)
    assert result.is_error
    text = " ".join(block.text for block in result.content)
    assert AuthError.MESSAGE in text
    for internal in ("x-tenant-id", "x-workspace-id", "edge", "sidecar"):
        assert internal not in text
    if contract:
        assert result.structured_content == {
            "error": {"code": "auth_required", "retryable": False, "message": AuthError.MESSAGE}
        }
