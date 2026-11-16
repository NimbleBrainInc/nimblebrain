"""The notes server, checked the way a host reads it, on both protocol eras."""

import pytest
from fastmcp import Client
from notes import NOTES, mcp

from nimblebrain_server_sdk.testing import Mode, served_facets


@pytest.fixture(autouse=True)
def empty_store() -> None:
    NOTES.clear()


@pytest.mark.parametrize("mode", ["auto", "legacy"])  # 2026-07-28, then 2025-11-25
async def test_a_saved_note_reads_back_and_is_counted(mode: Mode) -> None:
    async with Client(mcp, mode=mode) as client:
        saved = await client.call_tool("save_note", {"text": "hello"})
        note = await client.call_tool("get_note", {"note_id": saved.data["id"]})
    assert note.data == {"id": saved.data["id"], "text": "hello"}
    assert await served_facets(mcp, mode) == {
        "notes-total": {"title": "Notes", "level": "info", "count": 1}
    }


async def test_a_missing_note_is_a_not_found_error() -> None:
    async with Client(mcp) as client:
        result = await client.call_tool("get_note", {"note_id": "nt_0"}, raise_on_error=False)
    assert result.is_error
    assert result.structured_content == {
        "error": {"code": "not_found", "retryable": False, "message": "No note has that id."}
    }
