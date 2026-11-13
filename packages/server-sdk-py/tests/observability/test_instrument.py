"""End-to-end: a FastAPI app instrumented by the lib satisfies the observability contract."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.testclient import TestClient

from nimblebrain_server_sdk.observability import counter, gauge, get_logger, instrument_app


def _make_app() -> FastAPI:
    app = FastAPI()

    @app.get("/tasks/{task_id}")
    def get_task(task_id: str) -> dict:
        return {"task_id": task_id}

    @app.get("/boom")
    def boom() -> dict:
        raise ValueError("kaboom")

    @app.get("/log")
    def log_in_handler() -> dict:
        # Emitted *inside* the request scope, before the middleware clears
        # context — this is where identity stamping must hold.
        get_logger("test").info("in_handler")
        return {"ok": True}

    instrument_app(app, service="test-svc")
    return app


def test_metrics_endpoint_exposes_red_metrics():
    client = TestClient(_make_app(), raise_server_exceptions=False)
    client.get("/tasks/abc")
    client.get("/tasks/def")

    body = client.get("/metrics").text
    assert "http_requests_total" in body
    assert "http_request_duration_seconds" in body
    # Route template collapses per-id cardinality to one series.
    assert 'route="/tasks/{task_id}"' in body


def test_route_template_not_raw_path():
    client = TestClient(_make_app(), raise_server_exceptions=False)
    client.get("/tasks/secret-id-12345")
    body = client.get("/metrics").text
    assert "secret-id-12345" not in body  # raw id must never become a label


def test_correlation_id_echoed_and_derived_from_traceparent():
    client = TestClient(_make_app(), raise_server_exceptions=False)
    tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    resp = client.get("/tasks/abc", headers={"traceparent": tp})
    assert resp.headers["x-correlation-id"] == "0af7651916cd43dd8448eb211c80319c"


def test_correlation_id_generated_when_absent():
    client = TestClient(_make_app(), raise_server_exceptions=False)
    resp = client.get("/tasks/abc")
    assert len(resp.headers.get("x-correlation-id", "")) > 0


def test_malformed_traceparent_does_not_500():
    """A 32-char non-hex trace-id must be treated as absent (W3C), not crash."""
    client = TestClient(_make_app(), raise_server_exceptions=False)
    tp = "00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-b7ad6b7169203331-01"  # 32 chars, not hex
    resp = client.get("/tasks/abc", headers={"traceparent": tp})
    assert resp.status_code == 200
    # Fell through to a freshly minted id rather than the bad trace-id.
    cid = resp.headers["x-correlation-id"]
    assert cid and cid != "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"


def test_errors_counted_as_5xx():
    client = TestClient(_make_app(), raise_server_exceptions=False)
    client.get("/boom")
    body = client.get("/metrics").text
    assert 'status="500"' in body


def _last_json_event(captured: str, event: str) -> dict:
    for raw in reversed(captured.strip().splitlines()):
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if line.get("event") == event:
            return line
    raise AssertionError(f"no JSON log line with event={event!r}")


def test_logs_are_json_with_context(capsys):
    """The headline guarantee: a log emitted in a request scope is stamped
    with the verified tenant/workspace and the active OTel trace id."""
    client = TestClient(_make_app(), raise_server_exceptions=False)
    tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    client.get(
        "/log",
        headers={"x-tenant-id": "tenant-a", "x-workspace-id": "ws-1", "traceparent": tp},
    )

    line = _last_json_event(capsys.readouterr().out, "in_handler")
    assert line["service"] == "test-svc"
    assert line["tenant_id"] == "tenant-a"
    assert line["workspace_id"] == "ws-1"
    # trace_id comes from the active span (continues the inbound traceparent),
    # so it equals the traceparent's trace-id — not a fabricated value.
    assert line["trace_id"] == "0af7651916cd43dd8448eb211c80319c"


def test_context_cleared_after_request(capsys):
    """Context must not leak across requests: a log outside any request scope
    carries no identity fields."""
    client = TestClient(_make_app(), raise_server_exceptions=False)
    client.get("/log", headers={"x-tenant-id": "tenant-a", "x-workspace-id": "ws-1"})

    get_logger("test").info("outside_scope")
    line = _last_json_event(capsys.readouterr().out, "outside_scope")
    assert "tenant_id" not in line
    assert "workspace_id" not in line


def test_domain_counter_on_shared_registry():
    _make_app()
    c = counter("widgets_total", "Widgets.", ("kind",))
    c.labels("blue").inc()
    client = TestClient(_make_app(), raise_server_exceptions=False)
    assert "widgets_total" in client.get("/metrics").text


def test_domain_gauge_on_shared_registry():
    g = gauge("widget_level", "Current widget level.", ("kind",))
    g.labels("blue").set(3)
    client = TestClient(_make_app(), raise_server_exceptions=False)
    body = client.get("/metrics").text
    assert "widget_level" in body
    # A gauge reads its current level — settable down as well as up.
    g.labels("blue").set(0)
    assert 'widget_level{kind="blue"} 0.0' in client.get("/metrics").text


def test_dedicated_metrics_server_started_when_port_set(monkeypatch) -> None:
    """METRICS_PORT set => instrument_app starts the dedicated metrics server.

    Wiring is monkeypatched (no real socket bind) — the contract under test is
    "env METRICS_PORT -> start_metrics_server(port)", the edge-fronted runner path.
    """
    import nimblebrain_server_sdk.observability as p

    calls: list[int] = []
    monkeypatch.setattr(p, "start_metrics_server", lambda port: calls.append(port))
    monkeypatch.setenv("METRICS_PORT", "9100")

    p.instrument_app(FastAPI(), service="t")
    assert calls == [9100]


def test_no_dedicated_metrics_server_without_port(monkeypatch) -> None:
    """No METRICS_PORT => no dedicated server (services that aren't scraped bind nothing extra)."""
    import nimblebrain_server_sdk.observability as p

    calls: list[int] = []
    monkeypatch.setattr(p, "start_metrics_server", lambda port: calls.append(port))
    monkeypatch.delenv("METRICS_PORT", raising=False)

    p.instrument_app(FastAPI(), service="t")
    assert calls == []


def _starlette_app() -> Starlette:
    """A bare Starlette app — the shape FastMCP's http_app() presents."""

    async def task(request):
        return JSONResponse({"task_id": request.path_params["task_id"]})

    app = Starlette(routes=[Route("/tasks/{task_id}", task)])
    instrument_app(app, service="test-starlette")
    return app


def test_instrument_app_supports_bare_starlette_app() -> None:
    """instrument_app must satisfy the contract on a bare Starlette app, not just FastAPI:
    /metrics is mounted and exposes RED metrics with route-templated labels. This is
    the contract every FastMCP server depends on.
    """
    client = TestClient(_starlette_app(), raise_server_exceptions=False)
    client.get("/tasks/abc")
    client.get("/tasks/def")

    body = client.get("/metrics").text
    assert "http_requests_total" in body
    assert "http_request_duration_seconds" in body
    assert 'route="/tasks/{task_id}"' in body  # template, not per-id cardinality


def test_fastapi_tracing_skipped_on_non_fastapi_app(monkeypatch) -> None:
    """FastAPIInstrumentor only attaches to FastAPI. On a bare Starlette app it must be
    skipped (quietly, at debug) — not attempted-and-warned on every startup — and the
    guard must not over-skip a real FastAPI app.
    """
    attempted: list[str] = []
    monkeypatch.setattr(
        "opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app",
        lambda app, **_: attempted.append(type(app).__name__),
    )

    instrument_app(Starlette(), service="t-starlette")
    assert attempted == []  # skipped on a bare Starlette app

    instrument_app(FastAPI(), service="t-fastapi")
    assert attempted == ["FastAPI"]  # still attempted on a real FastAPI app


def test_start_metrics_server_serves_the_registry() -> None:
    """The dedicated metrics server actually binds a port and serves the shared
    registry (the in-app /metrics and this port render the SAME registry)."""
    import socket

    import httpx

    from nimblebrain_server_sdk.observability.metrics import start_metrics_server

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))  # grab a free ephemeral port
    port = sock.getsockname()[1]
    sock.close()

    start_metrics_server(
        port
    )  # binds synchronously before returning, then serves on a daemon thread
    resp = httpx.get(f"http://127.0.0.1:{port}/metrics", timeout=5.0)
    assert resp.status_code == 200
    assert "service_errors_total" in resp.text  # a known series from the shared registry


# The MCP SDK sends every modern-era SSE response with one module-level headers list.
_SHARED_SSE_HEADERS: list[tuple[bytes, bytes]] = [(b"content-type", b"text/event-stream")]


def _shared_headers_app(headers) -> Starlette:
    """A bare app whose raw ASGI endpoint sends the same ``headers`` object every time."""

    async def raw(scope, receive, send) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": headers})
        await send({"type": "http.response.body", "body": b"data: {}\n\n"})

    app = Starlette(routes=[Mount("/sse", app=raw)])
    instrument_app(app, service="test-svc")
    return app


def test_correlation_id_shared_headers_list_not_mutated() -> None:
    """Each response carries one x-correlation-id and the sender's list stays as it was.

    Appending to the list the app handed over would add a header to every later response
    sent from it; past a proxy's header limit, those responses stop parsing.
    """
    before = list(_SHARED_SSE_HEADERS)
    client = TestClient(_shared_headers_app(_SHARED_SSE_HEADERS))
    for _ in range(300):
        resp = client.get("/sse/")
        assert len(resp.headers.get_list("x-correlation-id")) == 1
    assert before == _SHARED_SSE_HEADERS


@pytest.mark.parametrize("headers", [((b"content-type", b"text/event-stream"),), None])
def test_correlation_id_added_when_headers_tuple_or_none(headers) -> None:
    resp = TestClient(_shared_headers_app(headers)).get("/sse/")
    assert resp.status_code == 200
    assert len(resp.headers.get_list("x-correlation-id")) == 1
