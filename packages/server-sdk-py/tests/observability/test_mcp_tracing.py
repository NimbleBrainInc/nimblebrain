"""A FastMCP runner's request span is FastMCP's own, parented on the inbound traceparent.

FastMCP opens one SERVER span per MCP request. This lib opens none on a FastMCP app, so the
server ships exactly one span per request, and instrument_app's only job is to hand FastMCP
the caller's trace context so the span joins the caller's trace instead of starting one.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastmcp import FastMCP
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from starlette.testclient import TestClient

from nimblebrain_server_sdk.observability import instrument_app
from nimblebrain_server_sdk.observability.tracing import configure_tracing

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
MODERN = "2026-07-28"


@pytest.fixture
def spans() -> Iterator[InMemorySpanExporter]:
    configure_tracing("probe")  # what instrument_app installs; a no-op once installed
    provider = trace.get_tracer_provider()
    assert isinstance(provider, TracerProvider)
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    yield exporter
    exporter.clear()


def _call(headers: dict[str, str]) -> None:
    mcp = FastMCP("probe")

    @mcp.tool()
    def ping() -> str:
        return "pong"

    app = mcp.http_app(json_response=True)
    instrument_app(app, service="probe")
    with TestClient(app) as client:
        response = client.post(
            "/mcp",
            headers={
                "accept": "application/json, text/event-stream",
                "content-type": "application/json",
                "mcp-protocol-version": MODERN,
                "mcp-method": "tools/call",
                "mcp-name": "ping",
                **headers,
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "ping",
                    "arguments": {},
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": MODERN,
                        "io.modelcontextprotocol/clientInfo": {"name": "p", "version": "0"},
                        "io.modelcontextprotocol/clientCapabilities": {},
                    },
                },
            },
        )
    assert response.status_code == 200, response.text


def _server_spans(exporter: InMemorySpanExporter):
    return [s for s in exporter.get_finished_spans() if s.kind == trace.SpanKind.SERVER]


def test_one_server_span_per_request_parented_on_the_inbound_traceparent(spans):
    _call({"traceparent": f"00-{TRACE_ID}-{PARENT_SPAN_ID}-01"})

    [span] = _server_spans(spans)
    assert span.name == "tools/call ping"
    assert format(span.context.trace_id, "032x") == TRACE_ID
    assert span.parent is not None
    assert format(span.parent.span_id, "016x") == PARENT_SPAN_ID


def test_with_no_traceparent_the_span_starts_its_own_trace(spans):
    _call({})

    [span] = _server_spans(spans)
    assert span.parent is None
