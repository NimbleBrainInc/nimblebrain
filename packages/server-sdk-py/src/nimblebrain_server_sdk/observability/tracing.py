"""Distributed tracing — the trace half of the observability contract.

W3C ``traceparent`` propagated across every hop. Inbound extraction + span
creation is handled by the FastAPI instrumentation; this module owns provider
setup and the **outbound** propagation helper that services use at trust
boundaries the auto-instrumentation can't see: a token-exchange call to
another service, or a handoff to a job it spawns (inject into the job's
env/labels so the spawned work stays on the trace).

Backend-neutral by construction: spans export over **OTLP** to whatever
``OTEL_EXPORTER_OTLP_ENDPOINT`` points at. Swapping backends is a
config change, never a code change. With no endpoint set, a provider is still
installed so trace ids exist for log correlation — just nothing is exported.
"""

from __future__ import annotations

import os

from opentelemetry import propagate, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_configured = False


def configure_tracing(service: str) -> None:
    """Install a TracerProvider; add an OTLP exporter iff an endpoint is set."""
    global _configured
    if _configured:
        return

    provider = TracerProvider(resource=Resource.create({"service.name": service}))

    endpoint = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint:
        # Lazy import keeps the exporter optional at runtime even though it's a dep.
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))

    trace.set_tracer_provider(provider)
    _configured = True


def inject_trace_headers(headers: dict[str, str] | None = None) -> dict[str, str]:
    """Inject ``traceparent`` (+ baggage) into an outbound header dict.

    Use at trust boundaries the auto-instrumentation doesn't cover so the trace
    survives the hop:

        httpx.post(url, headers=inject_trace_headers({"authorization": token}))
    """
    carrier = dict(headers or {})
    propagate.inject(carrier)
    return carrier
