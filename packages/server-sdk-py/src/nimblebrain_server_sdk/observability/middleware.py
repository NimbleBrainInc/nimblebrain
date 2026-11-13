"""The ASGI middleware that records RED metrics and binds request context.

Pure-ASGI (no Starlette ``BaseHTTPMiddleware`` overhead). Per request it:

1. derives the **correlation id** — from inbound ``traceparent`` (its trace id),
   else an ``x-correlation-id`` header, else a fresh id — so every request is
   followable end to end even before tracing is fully wired;
2. binds the identity headers (``x-tenant-id`` / ``x-workspace-id``) into the
   context that logs and spans read. This layer does **not** verify identity —
   it trusts the headers set by the verified-identity boundary upstream
   (the edge, which derives them from the cryptographically-verified token).
   Services behind the edge must not be reachable directly (a network policy);
   this is plumbing, not an authz gate;
3. times the request and records RED metrics against the matched **route
   template** (low cardinality);
4. echoes ``x-correlation-id`` back on the response for client-side stitching.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable

from opentelemetry import context as otel_context
from opentelemetry import propagate

from .context import bind_context, clear_context, get_correlation_id
from .metrics import IN_FLIGHT, REQUEST_DURATION, REQUESTS

# An infra-plane service supplies this to attribute a request to its *caller*
# (its identity axis in place of a tenant). It receives a header lookup and
# returns the (already-bounded) caller bucket. See instrument_app(caller_resolver=).
CallerResolver = Callable[[Callable[[str], "str | None"]], "str | None"]


def _header(headers: list[tuple[bytes, bytes]], name: str) -> str | None:
    target = name.encode()
    for k, v in headers:
        if k.lower() == target:
            return v.decode()
    return None


def _correlation_from(headers: list[tuple[bytes, bytes]]) -> str:
    traceparent = _header(headers, "traceparent")
    if traceparent:
        parts = traceparent.split("-")
        # 00-<32hex trace-id>-<16hex span-id>-<flags>
        if len(parts) >= 2 and len(parts[1]) == 32:
            try:
                if int(parts[1], 16) != 0:
                    return parts[1]
            except ValueError:
                # 32 chars but not hex: malformed. W3C says treat a bad
                # traceparent as absent (restart the trace), never error — and
                # this parse must never be able to 500 a request in the
                # reference middleware every service adopts.
                pass
    if existing := _header(headers, "x-correlation-id"):
        return existing
    # True entry point with no upstream context: mint a fresh id for the
    # `x-correlation-id` echo header. NOTE this id won't equal the OTel-generated
    # trace id for this request (this middleware runs outside the OTel span), so
    # at a bare entry point the echo header and the exported trace id diverge.
    # Benign: it's only a client-stitching convenience, and logs are unaffected —
    # the log line's `trace_id` is read from the active span at emit time (see
    # logging._inject_trace_id), never from this minted value.
    return uuid.uuid4().hex


class ObservabilityMiddleware:
    """RED metrics + context binding for every HTTP request."""

    def __init__(
        self,
        app,
        *,
        metrics_path: str = "/metrics",
        caller_resolver: CallerResolver | None = None,
    ) -> None:
        self.app = app
        self.metrics_path = metrics_path
        # None for tenant/fleet services (no caller axis) → caller stays unbound and
        # absent from their logs. Set only by opted-in infra-plane services.
        self.caller_resolver = caller_resolver

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Don't instrument the metrics scrape itself — pure noise on the series.
        if scope.get("path") == self.metrics_path:
            await self.app(scope, receive, send)
            return

        headers = scope.get("headers") or []
        method = scope.get("method", "GET")
        correlation_id = _correlation_from(headers)

        # Infra-plane caller (opt-in): resolve+bind it so every log line in this
        # request scope carries it. The resolver bounds cardinality itself.
        caller = None
        if self.caller_resolver is not None:
            caller = self.caller_resolver(lambda n: _header(headers, n))

        bind_context(
            tenant_id=_header(headers, "x-tenant-id"),
            workspace_id=_header(headers, "x-workspace-id"),
            correlation_id=correlation_id,
            caller=caller,
        )

        status_code = 500  # default: if the app errors before sending, it's a 5xx
        start = time.perf_counter()
        IN_FLIGHT.labels(method).inc()

        async def _send(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                cid = get_correlation_id()
                if cid:
                    # A new message and a new list: the app may send one headers object
                    # for every response (the MCP SDK's modern SSE path does), so an
                    # in-place append would add a header to every later response.
                    headers = message.get("headers") or ()
                    cid_header = (b"x-correlation-id", cid.encode())
                    message = {**message, "headers": [*headers, cid_header]}
            await send(message)

        try:
            await self.app(scope, receive, _send)
        finally:
            elapsed = time.perf_counter() - start
            IN_FLIGHT.labels(method).dec()
            # The matched route template (e.g. /tasks/{task_id}); falls back to the
            # raw path's shape only when nothing matched, kept low-cardinality.
            route = scope.get("route")
            route_label = getattr(route, "path", None) or "__unmatched__"

            REQUESTS.labels(method, route_label, str(status_code)).inc()
            REQUEST_DURATION.labels(method, route_label).observe(elapsed)
            clear_context()


class TraceContextMiddleware:
    """Make the inbound ``traceparent`` the OpenTelemetry context of the request.

    For an app with no HTTP instrumentation of its own: a FastMCP ``http_app()`` is a bare
    Starlette app, which ``FastAPIInstrumentor`` cannot attach to. FastMCP opens one SERVER
    span per MCP request itself, and parents it on the active context; without this, that
    context is empty and every request starts a trace of its own instead of joining the
    caller's. Opens no span: the MCP span is FastMCP's.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        carrier = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        token = otel_context.attach(propagate.extract(carrier))
        try:
            await self.app(scope, receive, send)
        finally:
            otel_context.detach(token)
