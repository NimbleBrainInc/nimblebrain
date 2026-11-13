"""Header values the middleware reads may hold bytes that are not UTF-8.

An HTTP/1.1 server passes obs-text (0x80-0xFF) in a header value through to the app.
The middleware reads such a value as absent: the request is served, counted, and given a
correlation id, and the other headers are read as usual. Starlette's ``TestClient`` encodes
header values as ASCII, so these tests drive the middleware over raw ASGI.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

import pytest

# The library under test: only these lines name it.
from nimblebrain_server_sdk.observability.context import current_context, get_correlation_id
from nimblebrain_server_sdk.observability.metrics import REGISTRY
from nimblebrain_server_sdk.observability.middleware import ObservabilityMiddleware

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
TRACEPARENT = f"00-{TRACE_ID}-b7ad6b7169203331-01".encode()
SERVED = {"method": "GET", "route": "__unmatched__", "status": "200"}


def _sample(name: str, labels: dict[str, str]) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def _drive(
    headers: list[tuple[bytes, bytes]], **middleware: Any
) -> tuple[dict[str, str] | None, list[dict[str, Any]]]:
    """Serve one request through the middleware; return the context the app saw and the
    messages sent (``None`` for the context when the app was never called)."""
    seen: list[dict[str, str]] = []
    sent: list[dict[str, Any]] = []

    async def app(scope, receive, send) -> None:
        seen.append({**current_context(), "correlation_id": get_correlation_id() or ""})
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b""}

    async def send(message) -> None:
        sent.append(message)

    scope = {"type": "http", "method": "GET", "path": "/raw", "headers": headers}
    asyncio.run(ObservabilityMiddleware(app, **middleware)(scope, receive, send))
    return (seen[0] if seen else None), sent


@pytest.mark.parametrize(
    "name", [b"x-correlation-id", b"traceparent", b"x-tenant-id", b"x-workspace-id"]
)
def test_non_utf8_header_read_as_absent(name: bytes) -> None:
    served = _sample("http_requests_total", SERVED)

    ctx, sent = _drive([(name, b"\xff")])

    assert ctx is not None, "the application was not called"
    assert "tenant_id" not in ctx
    assert "workspace_id" not in ctx
    # No usable upstream id: a fresh one is minted and echoed.
    assert re.fullmatch(r"[0-9a-f]{32}", ctx["correlation_id"])
    assert sent[0]["status"] == 200
    assert (b"x-correlation-id", ctx["correlation_id"].encode()) in sent[0]["headers"]
    assert _sample("http_requests_total", SERVED) == served + 1
    assert _sample("http_in_flight_requests", {"method": "GET"}) == 0


def test_non_utf8_header_leaves_other_headers_read() -> None:
    ctx, _ = _drive(
        [
            (b"x-correlation-id", b"\xff"),
            (b"traceparent", TRACEPARENT),
            (b"x-tenant-id", b"tenant-a"),
        ]
    )
    assert ctx is not None
    assert ctx["correlation_id"] == TRACE_ID
    assert ctx["tenant_id"] == "tenant-a"


def test_non_utf8_traceparent_falls_through_to_correlation_header() -> None:
    ctx, _ = _drive([(b"traceparent", b"\xff"), (b"x-correlation-id", b"corr-a")])
    assert ctx is not None
    assert ctx["correlation_id"] == "corr-a"


def test_utf8_non_ascii_header_kept_as_sent() -> None:
    """Only an undecodable value is dropped; valid UTF-8 beyond ASCII is read as UTF-8."""
    ctx, _ = _drive([(b"x-tenant-id", "tenant-é".encode())])
    assert ctx is not None
    assert ctx["tenant_id"] == "tenant-é"


def test_caller_resolver_receives_none_for_non_utf8_header() -> None:
    received: list[str | None] = []

    def resolver(get_header) -> str | None:
        received.append(get_header("x-caller"))
        return "caller-a"

    ctx, _ = _drive([(b"x-caller", b"\xff")], caller_resolver=resolver)
    assert received == [None]
    assert ctx is not None
    assert ctx["caller"] == "caller-a"
