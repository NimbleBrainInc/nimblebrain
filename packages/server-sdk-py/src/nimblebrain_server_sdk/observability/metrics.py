"""RED metrics — the metrics half of the observability contract.

Baseline **R**ate / **E**rrors / **D**uration per HTTP route, recorded by the
middleware, plus thin factories services use to declare their own domain metrics
(task lifecycle, token mints, …) on the same registry so one `/metrics` scrape
covers everything.

Route labels use the matched **route template** (``/tasks/{task_id}``), never the
raw path, so per-id cardinality can't explode the series count. Identity
(``tenant_id``) is deliberately NOT a metric label by default — that lives on log
lines and trace attributes where the cardinality is safe. Per-tenant metric
labels would be an explicit, considered opt-in.
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest

# One registry per process. The middleware and domain metrics share it; the
# `/metrics` endpoint renders it. (Not the global default registry, so tests and
# multiple apps in one interpreter stay isolated.)
REGISTRY = CollectorRegistry()

# Duration buckets tuned for agent/LLM-shaped latencies (sub-ms rare; multi-second
# common; long tail to 120s, matching the edge's own histogram).
_DURATION_BUCKETS = (
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
    120.0,
)

REQUESTS = Counter(
    "http_requests_total",
    "Total HTTP requests (Rate + Errors).",
    labelnames=("method", "route", "status"),
    registry=REGISTRY,
)

REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency (Duration).",
    labelnames=("method", "route"),
    buckets=_DURATION_BUCKETS,
    registry=REGISTRY,
)

IN_FLIGHT = Gauge(  # inc on entry / dec on exit — no shared mutable module state
    "http_in_flight_requests",
    "In-flight HTTP requests (exposed for HPA visibility).",
    labelnames=("method",),
    registry=REGISTRY,
)

# The Errors signal RED can't see: in-band failures (an MCP tool error inside an
# HTTP 200) classified into the closed taxonomy. Labels are a closed set — `code`
# is the taxonomy, `upstream_status` a bounded set of HTTP codes (empty when none);
# identity is deliberately absent (it lives on logs/spans). Recorded by the error
# surface adapters (see error_surface), not at call sites.
SERVICE_ERRORS = Counter(
    "service_errors_total",
    "Classified service errors by taxonomy code (the in-band errors RED can't see).",
    labelnames=("service", "code", "upstream_status"),
    registry=REGISTRY,
)

# Process-scope service name, set once by instrument_app, stamped on SERVICE_ERRORS.
# Assumes one service per process (one image, one instrument_app call). A second instrument_app call would relabel ALL prior
# service_errors_total series — don't instrument two services in one interpreter.
_service_name = "unknown"


def set_service_name(name: str) -> None:
    global _service_name
    _service_name = name


def record_service_error(code: str, upstream_status: int | None = None) -> None:
    """Increment ``service_errors_total`` for a classified error. Called by the
    surface adapters in ``error_surface`` so emission stays in one place."""
    SERVICE_ERRORS.labels(
        _service_name, code, "" if upstream_status is None else str(upstream_status)
    ).inc()


def counter(name: str, documentation: str, labelnames: tuple[str, ...] = ()) -> Counter:
    """Declare a domain counter on the shared registry (e.g. ``tasks_created_total``)."""
    return Counter(name, documentation, labelnames=labelnames, registry=REGISTRY)


def histogram(
    name: str,
    documentation: str,
    labelnames: tuple[str, ...] = (),
    buckets: tuple[float, ...] = _DURATION_BUCKETS,
) -> Histogram:
    """Declare a domain histogram on the shared registry (e.g. ``forward_seconds``).

    For a *distribution* a counter cannot express — how long a domain operation
    took, not how many there were. Defaults to the same agent/LLM-shaped duration
    buckets the RED histogram uses, so a domain latency and its route latency are
    readable on one axis; pass ``buckets`` for a non-duration distribution.
    """
    return Histogram(name, documentation, labelnames=labelnames, buckets=buckets, registry=REGISTRY)


def gauge(name: str, documentation: str, labelnames: tuple[str, ...] = ()) -> Gauge:
    """Declare a domain gauge on the shared registry (e.g. a current-state level
    like ``downstream_resolvable{service,dep}``).

    Use for a value that can go up *and* down — a level to read now, not a
    monotonic total (that's ``counter``). Rides the same ``/metrics`` scrape.
    """
    return Gauge(name, documentation, labelnames=labelnames, registry=REGISTRY)


def render() -> tuple[bytes, str]:
    """Render the registry as Prometheus text. Returns (body, content_type)."""
    from prometheus_client import CONTENT_TYPE_LATEST

    return generate_latest(REGISTRY), CONTENT_TYPE_LATEST


def start_metrics_server(port: int) -> None:
    """Serve the shared registry on a DEDICATED port (background thread).

    For edge-fronted runner services whose app port also serves ``/mcp``: scraping
    the app port would require admitting the monitoring namespace to a port that
    also serves ``/mcp`` (an edge-bypass). This binds a metrics-ONLY port instead,
    so the network policy can admit Prometheus to it alone. Serves the same
    ``REGISTRY`` as the in-app ``/metrics`` route.

    Assumes one process per port (a single uvicorn worker — the runner image runs
    one); the port is bound once at startup.
    """
    from prometheus_client import start_http_server

    start_http_server(port, registry=REGISTRY)
