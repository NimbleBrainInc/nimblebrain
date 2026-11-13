"""Observability for a server: RED metrics, structured JSON logs and W3C trace propagation.

Needs the ``[observability]`` extra (``pip install 'nimblebrain-server-sdk[observability]'``);
imported without it, this package raises an ``ImportError`` that names the extra.

A server becomes observable by adopting this package rather than hand-rolling
instrumentation. Wiring is three lines:

    from nimblebrain_server_sdk.observability import instrument_app, get_logger

    app = create_app()
    instrument_app(app, service="notes")
    log = get_logger(__name__)

After that: ``GET /metrics`` serves the registry, every log line is JSON stamped
with the verified ``tenant_id`` / ``workspace_id`` and the active OTel
``trace_id``, and ``traceparent`` is extracted inbound and exported over OTLP
(when an endpoint is configured). Domain metrics ride the same registry via ``counter()``;
cross-boundary calls propagate the trace via ``inject_trace_headers()``.

The error contract (``ServiceError``, ``ErrorCode``, ``to_tool_error``,
``rate_limited_tool_error``, ``CapacityRefusal``) lives in ``nimblebrain_server_sdk.errors``
and is re-exported here as the same objects.
"""

from __future__ import annotations

import os
from typing import Any

from nimblebrain_server_sdk._extras import require_extra

require_extra(
    "nimblebrain_server_sdk.observability",
    "observability",
    ("prometheus_client", "structlog", "opentelemetry.sdk.trace"),
)

from nimblebrain_server_sdk.errors import (  # noqa: E402
    CapacityRefusal,
    ErrorCode,
    ServiceError,
    rate_limited_tool_error,
    to_tool_error,
)

from .logging import configure_logging, get_logger  # noqa: E402
from .metrics import (  # noqa: E402
    counter,
    gauge,
    histogram,
    render,
    set_service_name,
    start_metrics_server,
)
from .middleware import ObservabilityMiddleware, TraceContextMiddleware  # noqa: E402
from .tracing import configure_tracing, inject_trace_headers  # noqa: E402

# The consumed contract surface only: counter/gauge/histogram are the metric factories,
# instrument_app/get_logger/inject_trace_headers are the adoption seam. Anything
# no one calls yet isn't shipped — add it back with the adopter that needs it.
__all__ = [
    "instrument_app",
    "service_version",
    "get_logger",
    "counter",
    "gauge",
    "histogram",
    "inject_trace_headers",
    # error contract
    "ServiceError",
    "ErrorCode",
    "to_tool_error",
    # A call refused for capacity (a database server's workspace limit): a server on
    # nimblebrain_server_sdk.db returns it as rate_limited.
    "CapacityRefusal",
    "rate_limited_tool_error",
]


def service_version() -> str:
    """The running service's own version, for the MCP ``serverInfo.version`` field.

    Read from ``SERVICE_VERSION``, which the deployment sets to the deployed version
    (``0.2.0`` for a release, a short SHA for a staging build), so a server reports exactly
    what's deployed.
    Falls back to ``"dev"`` for a local run with nothing injected.

    Pass the result as ``FastMCP(name, version=service_version())``. A server that
    omits ``version=`` reports the FastMCP *library* version instead, which tells a
    connecting client nothing about the service.
    """
    return os.environ.get("SERVICE_VERSION") or "dev"


def _is_fastapi(app: Any) -> bool:
    """Whether ``app`` is a FastAPI app, without making FastAPI a dependency."""
    try:
        from fastapi import FastAPI
    except ImportError:
        return False
    return isinstance(app, FastAPI)


def instrument_app(
    app,
    *,
    service: str,
    metrics_path: str = "/metrics",
    log_level: str = "INFO",
    caller_resolver=None,
):
    """Make a FastAPI/Starlette app observable. Call once after creating the app.

    - configures JSON-to-stdout logging stamped with request context
    - installs the OTLP tracer provider + FastAPI auto-instrumentation
    - adds the RED-metrics + context-binding middleware
    - mounts ``GET {metrics_path}`` serving the Prometheus registry
    - if ``METRICS_PORT`` is set, ALSO serves the registry on that dedicated port

    The dedicated ``METRICS_PORT`` is for edge-fronted servers whose app
    port also serves ``/mcp``: Prometheus scrapes the metrics-only port (admitted
    by a network policy), so ``/mcp`` is never exposed to the monitoring namespace.

    ``caller_resolver`` is the infra-plane opt-in: a service with no tenant is attributed
    by its *caller*. Pass a ``fn(get_header) -> caller`` and every log line in the
    request scope carries ``caller``. Tenant/fleet services omit it — their logs are
    unchanged. The resolver must bound cardinality (collapse unknowns to one bucket).
    """
    configure_logging(service, level=log_level)
    configure_tracing(service)
    set_service_name(service)  # stamped on service_errors_total by the error surface

    # Auto-create a span per request + extract/propagate inbound traceparent.
    # Don't trace the scrape itself. excluded_urls is re.search'd against the full
    # URL, so end-anchor the path (a leading ^ would never match "http://host/metrics");
    # the $ keeps it from also excluding e.g. /metrics-dashboard.
    #
    # FastAPIInstrumentor only attaches to a FastAPI app. FastMCP servers pass a bare
    # Starlette http_app(), where it can't attach — that's EXPECTED, not an anomaly. Their
    # request span is FastMCP's own (one SERVER span per MCP request, spec error codes);
    # TraceContextMiddleware parents it on the inbound traceparent, and this lib opens no
    # second span. A genuine failure on a real FastAPI app still warns.
    if _is_fastapi(app):
        try:
            from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

            FastAPIInstrumentor.instrument_app(app, excluded_urls=f"{metrics_path}$")
        except Exception:  # noqa: BLE001 — tracing is best-effort; never block startup
            get_logger(__name__).warning("fastapi_tracing_instrumentation_skipped")
    else:
        app.add_middleware(TraceContextMiddleware)

    app.add_middleware(
        ObservabilityMiddleware, metrics_path=metrics_path, caller_resolver=caller_resolver
    )

    # Mount via Starlette's add_route (which FastAPI inherits) rather than the
    # FastAPI-only @app.get, so the same call instruments a FastMCP `http_app()`
    # (a bare Starlette app) as well as a FastAPI service.
    from starlette.responses import Response

    async def _metrics(_request):  # pragma: no cover — exercised via the app, see tests
        body, content_type = render()
        return Response(content=body, media_type=content_type)

    app.add_route(metrics_path, _metrics, methods=["GET"], include_in_schema=False)

    # Optional dedicated metrics port (edge-fronted servers): serve the
    # SAME registry on a port that serves ONLY metrics, so Prometheus can scrape
    # without the app port (which also serves /mcp) being admitted to monitoring.
    metrics_port = os.environ.get("METRICS_PORT")
    if metrics_port:
        start_metrics_server(int(metrics_port))

    return app
