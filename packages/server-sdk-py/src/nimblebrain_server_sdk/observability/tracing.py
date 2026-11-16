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

A recorded exception reaches the exporter with its message, stacktrace and, from FastMCP, the
span status set to ``str(exc)``. For a database error that text carries row data, so spans
pass through :class:`RedactingSpanExporter` on the way out (see ``_db_errors``).
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from opentelemetry import propagate, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter, SpanExportResult
from opentelemetry.trace import Status

from ._db_errors import WITHHELD, redact_exception_event

_configured = False


def _redacted(span: ReadableSpan) -> ReadableSpan:
    """``span``, or a copy whose database-error exception events and status hold no message."""
    events: list[Event] = []
    changed = False
    for event in span.events:
        attributes = redact_exception_event(event.attributes or {})
        if event.name == "exception" and attributes is not None:
            events.append(Event(event.name, attributes, event.timestamp))
            changed = True
        else:
            events.append(event)
    if not changed:
        return span
    status = span.status
    if status.description:
        status = Status(status.status_code, WITHHELD)
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=span.attributes,
        events=events,
        links=span.links,
        kind=span.kind,
        status=status,
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


class RedactingSpanExporter(SpanExporter):
    """Exports through ``inner``, each database error's message withheld from the span."""

    def __init__(self, inner: SpanExporter) -> None:
        self._inner = inner

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._inner.export([_redacted(span) for span in spans])

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


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

        provider.add_span_processor(BatchSpanProcessor(RedactingSpanExporter(OTLPSpanExporter())))

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
