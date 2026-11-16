"""The lifecycle handlers as a host finds and calls them."""

import pytest
from fastmcp import Client
from lifecycle_server import PREPARED, lifecycle, mcp

from nimblebrain_server_sdk import LIFECYCLE_EXTENSION_ID
from nimblebrain_server_sdk.testing import Mode


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_the_host_finds_each_handler_by_its_marker_and_calls_it(mode: Mode) -> None:
    assert lifecycle.handlers == {"ready": "workspace_ready", "removing": "workspace_removing"}
    async with Client(mcp, mode=mode) as client:
        marked = {
            tool.meta[LIFECYCLE_EXTENSION_ID]["event"]: tool.name
            for tool in await client.list_tools()
            if tool.meta and LIFECYCLE_EXTENSION_ID in tool.meta
        }
        assert marked == lifecycle.handlers
        ready = await client.call_tool(marked["ready"], {"reason": "install"})
        assert ready.data == "ready (install)"
        assert PREPARED == {"workspace"}
        await client.call_tool(marked["removing"], {})
        assert PREPARED == set()
