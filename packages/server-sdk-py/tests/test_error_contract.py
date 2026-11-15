"""``add_error_contract``: a contract error a tool raises reaches the caller as the contract."""

from __future__ import annotations

import pytest
from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError

from nimblebrain_server_sdk import READS, add_error_contract, errors
from nimblebrain_server_sdk.errors import ErrorCode, ServiceError
from nimblebrain_server_sdk.testing import Mode

MODES: tuple[Mode, ...] = ("auto", "legacy")


class Refusal(Exception):
    message = "The server is at capacity right now. Nothing was run."
    next_step = "Wait a few seconds, then retry the call."


def server(*, contract: bool) -> FastMCP:
    mcp = FastMCP("contract")
    if contract:
        add_error_contract(mcp)

    @mcp.tool(annotations=READS)
    async def classified() -> str:
        raise ServiceError(ErrorCode.NOT_FOUND, "No such note.", detail="notes row 41 is gone")

    @mcp.tool(annotations=READS)
    async def refused() -> str:
        raise Refusal

    @mcp.tool(annotations=READS)
    async def broken() -> str:
        raise RuntimeError("a bug")

    @mcp.tool(annotations=READS)
    async def fine() -> str:
        return "ok"

    return mcp


@pytest.mark.parametrize("mode", MODES)
async def test_a_raised_service_error_is_returned_as_the_contract(mode: Mode) -> None:
    async with Client(server(contract=True), mode=mode) as client:
        result = await client.call_tool("classified", {}, raise_on_error=False)
    assert result.is_error
    assert result.structured_content == {
        "error": {"code": "not_found", "retryable": False, "message": "No such note."}
    }
    assert [block.text for block in result.content] == ["No such note."]


@pytest.mark.parametrize("mode", MODES)
async def test_a_raised_capacity_refusal_is_rate_limited(mode: Mode) -> None:
    async with Client(server(contract=True), mode=mode) as client:
        result = await client.call_tool("refused", {}, raise_on_error=False)
    assert result.is_error
    assert result.structured_content == {
        "error": {
            "code": "rate_limited",
            "retryable": True,
            "message": f"{Refusal.message} {Refusal.next_step}",
        }
    }


async def test_without_it_a_raised_service_error_has_no_code() -> None:
    async with Client(server(contract=False)) as client:
        result = await client.call_tool("classified", {}, raise_on_error=False)
    assert result.is_error
    assert result.structured_content is None


async def test_an_unclassified_exception_is_left_alone() -> None:
    async with Client(server(contract=True)) as client:
        with pytest.raises(ToolError, match="a bug"):
            await client.call_tool("broken", {})
        assert (await client.call_tool("fine", {})).data == "ok"


async def test_the_error_is_recorded_once(monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[ServiceError] = []
    monkeypatch.setattr(errors, "_record", recorded.append)
    async with Client(server(contract=True)) as client:
        await client.call_tool("classified", {}, raise_on_error=False)
    assert [(err.code, err.message, err.detail) for err in recorded] == [
        (ErrorCode.NOT_FOUND, "No such note.", "notes row 41 is gone")
    ]
