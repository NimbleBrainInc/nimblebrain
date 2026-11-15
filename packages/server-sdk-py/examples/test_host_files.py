"""The tool on a connection with no host-resources: inline text works, a URI is refused."""

import pytest
from fastmcp import Client
from host_files import mcp

from nimblebrain_server_sdk.testing import Mode


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_inline_text_is_counted_and_a_uri_asks_for_text(mode: Mode) -> None:
    async with Client(mcp, mode=mode) as client:
        counted = await client.call_tool("word_count", {"text": "three short words"})
        assert counted.structured_content == {"words": 3}
        refused = await client.call_tool(
            "word_count", {"file_uri": "files://fl_1"}, raise_on_error=False
        )
    assert refused.is_error
    assert refused.structured_content == {
        "error": {
            "code": "bad_input",
            "retryable": False,
            "message": "This connection cannot read workspace files. Pass the contents as `text`.",
        }
    }
