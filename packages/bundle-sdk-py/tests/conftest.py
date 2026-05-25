"""Shared fixtures for the bundle-sdk tests.

The SDK is a thin wrapper over `fastmcp`'s `Context` and the underlying
`mcp` Python SDK. Rather than spin up a real MCP server/client pair
inside unit tests, we construct a `Context`-shaped stub whose `session`
exposes the two attributes the SDK actually touches:

  - `client_params.capabilities` — for `HostResources.available` and
    `.supports_scheme`. We stash a real `ClientCapabilities` so the
    SDK's `isinstance` guard passes; `extra="allow"` on the model lets
    us tuck `extensions` into `model_extra`.

  - `send_request(request, result_type)` — for `read` and `list`. We
    record every call (method name, dumped params) and return a
    pre-canned result so tests can assert on both sides of the wire.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest
from mcp.types import (
    ClientCapabilities,
    InitializeRequestParams,
    ListResourcesResult,
    ReadResourceResult,
)
from pydantic import BaseModel


@dataclass
class StubCall:
    """One recorded send_request invocation."""

    method: str
    params: dict[str, Any]


@dataclass
class StubSession:
    """Drop-in stub for `ServerSession` covering the SDK's surface area."""

    client_params: InitializeRequestParams | None = None
    next_response: Any = None
    calls: list[StubCall] = field(default_factory=list)

    async def send_request(
        self,
        request: BaseModel,
        result_type: type[BaseModel],
    ) -> Any:
        dumped = request.model_dump(by_alias=True, mode="json", exclude_none=True)
        self.calls.append(StubCall(method=dumped["method"], params=dumped.get("params", {})))
        if self.next_response is None:
            raise AssertionError(
                "Test did not configure `stub_session.next_response` before calling SDK."
            )
        return self.next_response


@dataclass
class StubContext:
    """Drop-in stub for `fastmcp.Context`. Only `session` is exposed."""

    session: StubSession


def make_capabilities(
    *,
    extensions: dict[str, Any] | None = None,
    experimental: dict[str, dict[str, Any]] | None = None,
) -> ClientCapabilities:
    """Build a `ClientCapabilities` carrying our extension declaration.

    The Python `mcp` SDK (1.27.0) doesn't have a typed `extensions`
    field — it lives in `model_extra` thanks to `extra="allow"`. We
    set it via Pydantic's construction extra-fields path.
    """
    payload: dict[str, Any] = {}
    if experimental is not None:
        payload["experimental"] = experimental
    if extensions is not None:
        payload["extensions"] = extensions
    return ClientCapabilities.model_validate(payload)


def make_ctx(
    *,
    extensions: dict[str, Any] | None = None,
    experimental: dict[str, dict[str, Any]] | None = None,
    next_response: Any = None,
) -> StubContext:
    """One-call builder for the most common test setup."""
    caps = make_capabilities(extensions=extensions, experimental=experimental)
    params = InitializeRequestParams.model_validate(
        {
            "protocolVersion": "2025-06-18",
            "capabilities": caps.model_dump(by_alias=True, exclude_none=True),
            "clientInfo": {"name": "stub", "version": "0.0.0"},
        }
    )
    session = StubSession(client_params=params, next_response=next_response)
    return StubContext(session=session)


@pytest.fixture
def host_resources_v1_extensions() -> dict[str, Any]:
    """Match the platform's HOST_RESOURCES_CAPABILITY_V1 wire shape."""
    return {
        "ai.nimblebrain/host-resources": {
            "read": {"enabled": True, "range": False, "maxSize": 10 * 1024 * 1024},
            "list": {"enabled": True},
            "write": {"enabled": False},
            "schemes": ["files"],
        }
    }


@pytest.fixture
def read_result_ok() -> ReadResourceResult:
    return ReadResourceResult.model_validate(
        {
            "contents": [
                {
                    "uri": "files://fl_abc",
                    "mimeType": "text/csv",
                    "text": "company,email\nfoo,foo@x",
                }
            ]
        }
    )


@pytest.fixture
def list_result_ok() -> ListResourcesResult:
    return ListResourcesResult.model_validate(
        {
            "resources": [
                {"uri": "files://fl_abc", "name": "rows.csv", "mimeType": "text/csv"},
            ]
        }
    )
