"""Golden: the spans an instrumented service exports, and how it carries a trace on.

Per request, every span in the request's trace: its name, its kind, and what it is parented
on (the caller's span from the inbound ``traceparent``, a span of this request, or nothing).
A FastAPI app gets its request span from the FastAPI instrumentation; a FastMCP
``http_app()`` gets FastMCP's own span, which the library parents on the inbound
``traceparent``. Also pinned: the ``service.name`` the tracer reports, and the headers
``inject_trace_headers`` adds for an outbound call.

``tests/golden/spans.json`` is frozen output with no regenerate path.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastmcp import FastMCP
from opentelemetry import context as otel_context
from opentelemetry import propagate, trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from starlette.testclient import TestClient

# The library under test: only these lines name it.
from nimblebrain_server_sdk.observability import inject_trace_headers, instrument_app

GOLDEN = Path(__file__).parent / "golden" / "spans.json"

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
TRACEPARENT = f"00-{TRACE_ID}-{PARENT_SPAN_ID}-01"
MODERN = "2026-07-28"


@pytest.fixture
def spans() -> Iterator[InMemorySpanExporter]:
    instrument_app(FastAPI(), service="golden-traces-svc")  # installs the tracer provider
    provider = trace.get_tracer_provider()
    assert isinstance(provider, TracerProvider)
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    yield exporter
    exporter.clear()


def _shape(finished: tuple[ReadableSpan, ...]) -> list[dict[str, Any]]:
    """Each span of one trace: name, kind, and the role of its parent."""
    assert len({span.context.trace_id for span in finished}) == 1
    own = {span.context.span_id for span in finished}
    out = []
    for span in finished:
        if span.parent is None:
            parent = "none"
        elif format(span.parent.span_id, "016x") == PARENT_SPAN_ID:
            parent = "inbound_traceparent"
        elif span.parent.span_id in own:
            parent = "span_of_this_request"
        else:
            parent = "other"
        out.append(
            {
                "name": span.name,
                "kind": span.kind.name,
                "parent": parent,
                "trace_id_is_inbound": format(span.context.trace_id, "032x") == TRACE_ID,
            }
        )
    return sorted(out, key=lambda s: json.dumps(s, sort_keys=True))


def _fastapi(exporter: InMemorySpanExporter, headers: dict[str, str]) -> list[dict[str, Any]]:
    app = FastAPI()

    @app.get("/golden-traces/items/{item_id}")
    def item(item_id: str) -> dict:
        return {"item_id": item_id}

    instrument_app(app, service="golden-traces-svc")
    exporter.clear()
    TestClient(app).get("/golden-traces/items/item-1", headers=headers)
    return _shape(exporter.get_finished_spans())


def _fastmcp(exporter: InMemorySpanExporter, headers: dict[str, str]) -> list[dict[str, Any]]:
    mcp = FastMCP("golden")

    @mcp.tool()
    def ping() -> str:
        return "pong"

    app = mcp.http_app(json_response=True)
    instrument_app(app, service="golden-traces-svc")
    with TestClient(app) as client:
        exporter.clear()
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
    return _shape(exporter.get_finished_spans())


def _outbound_headers() -> dict[str, str]:
    """What ``inject_trace_headers`` adds inside a request carrying ``TRACEPARENT``."""
    token = otel_context.attach(propagate.extract({"traceparent": TRACEPARENT}))
    try:
        return inject_trace_headers({"authorization": "Bearer token-a"})
    finally:
        otel_context.detach(token)


def _service_name() -> str:
    """The ``service.name`` resource a fresh process's tracer reports after ``instrument_app``.

    A fresh interpreter, because the tracer provider is installed once per process.
    """
    script = textwrap.dedent(
        f"""
        from opentelemetry import trace
        from starlette.applications import Starlette
        from {instrument_app.__module__} import instrument_app
        instrument_app(Starlette(), service="svc-a")
        print(trace.get_tracer_provider().resource.attributes["service.name"])
        """
    )
    done = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=True
    )
    return done.stdout.strip().splitlines()[-1]


def build(exporter: InMemorySpanExporter) -> dict[str, Any]:
    return {
        "fastapi": {
            "with_traceparent": _fastapi(exporter, {"traceparent": TRACEPARENT}),
            "without_traceparent": [
                {k: v for k, v in s.items() if k != "trace_id_is_inbound"}
                for s in _fastapi(exporter, {})
            ],
        },
        "fastmcp": {
            "with_traceparent": _fastmcp(exporter, {"traceparent": TRACEPARENT}),
            "without_traceparent": [
                {k: v for k, v in s.items() if k != "trace_id_is_inbound"}
                for s in _fastmcp(exporter, {})
            ],
        },
        "inject_trace_headers": _outbound_headers(),
        "service_name": _service_name(),
    }


def test_spans_match_golden(spans: InMemorySpanExporter) -> None:
    actual = json.loads(json.dumps(build(spans)))
    assert actual == json.loads(GOLDEN.read_text())
