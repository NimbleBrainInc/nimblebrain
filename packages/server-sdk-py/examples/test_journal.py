"""The journal under the host context a host stamps, on both protocol eras."""

from typing import Any

import pytest
from fastmcp import Client
from journal import ENTRIES, mcp

from nimblebrain_server_sdk import HOST_CONTEXT_META_KEY
from nimblebrain_server_sdk.testing import Mode

NOW = "2026-01-01T12:00:00.000Z"


def stamped(principal: str, workspace: str) -> dict[str, Any]:
    """The `_meta` a host sends: its context, with the workspace and its clock."""
    return {HOST_CONTEXT_META_KEY: {"principal": principal, "workspaceId": workspace, "now": NOW}}


@pytest.fixture(autouse=True)
def empty_journal() -> None:
    ENTRIES.clear()


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_a_workspace_reads_only_its_own_entries(mode: Mode) -> None:
    async with Client(mcp, mode=mode) as client:
        added = await client.call_tool(
            "add_entry", {"text": "hello"}, meta=stamped("person", "ws_a")
        )
        assert added.data == {"text": "hello", "at": NOW}
        own = await client.call_tool("list_entries", {}, meta=stamped("person", "ws_a"))
        other = await client.call_tool("list_entries", {}, meta=stamped("person", "ws_b"))
    assert own.structured_content == {"result": [{"text": "hello", "at": NOW}]}
    assert other.structured_content == {"result": []}


async def test_a_call_with_no_context_is_auth_required() -> None:
    async with Client(mcp) as client:
        result = await client.call_tool("list_entries", {}, raise_on_error=False)
    assert result.is_error
    assert result.structured_content is not None
    assert result.structured_content["error"]["code"] == "auth_required"


async def test_only_the_host_clears_a_workspace() -> None:
    async with Client(mcp) as client:
        await client.call_tool("add_entry", {"text": "hello"}, meta=stamped("person", "ws_a"))
        refused = await client.call_tool(
            "clear_workspace", {}, meta=stamped("person", "ws_a"), raise_on_error=False
        )
        cleared = await client.call_tool("clear_workspace", {}, meta=stamped("host", "ws_a"))
    assert refused.structured_content is not None
    assert refused.structured_content["error"]["code"] == "forbidden"
    assert cleared.data == {"deleted": 1}
