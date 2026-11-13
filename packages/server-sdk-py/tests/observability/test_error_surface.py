"""The FastMCP surface adapter must return a REAL ToolResult scored is_error.

Regression guard for the footgun: returning a plain dict from a FastMCP tool is
scored is_error=False (a success with the flag buried in structured data). The
helper must hand back a ToolResult(is_error=True) the tool can return directly.
"""

from __future__ import annotations

import json

from fastmcp.tools import ToolResult

from nimblebrain_server_sdk.observability import (
    ServiceError,
    rate_limited_tool_error,
    to_tool_error,
)


def test_to_tool_error_returns_real_toolresult_marked_error() -> None:
    err = ServiceError.from_upstream(402, detail="Exa API Error 402: … dashboard.exa.ai")
    result = to_tool_error(err)

    assert isinstance(result, ToolResult)
    assert result.is_error is True  # the whole point — not a dict scored as success
    envelope = result.structured_content["error"]
    assert envelope["code"] == "quota_exhausted"
    assert envelope["retryable"] is False
    assert envelope["upstream_status"] == 402
    # The raw vendor detail never reaches the host envelope.
    assert "dashboard.exa.ai" not in json.dumps(result.structured_content)


class _Refusal:
    message = "The workspace is at capacity. Nothing was run."
    next_step = "Retry shortly."


def test_rate_limited_tool_error_carries_the_refusals_text_as_retryable() -> None:
    result = rate_limited_tool_error(_Refusal())

    assert isinstance(result, ToolResult)
    assert result.is_error is True
    envelope = result.structured_content["error"]
    assert envelope["code"] == "rate_limited"
    assert envelope["retryable"] is True
    assert envelope["message"] == "The workspace is at capacity. Nothing was run. Retry shortly."
