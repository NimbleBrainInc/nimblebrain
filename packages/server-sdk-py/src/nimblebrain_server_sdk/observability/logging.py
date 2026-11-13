"""Structured JSON logging — the log half of the observability contract.

One shape for every service: JSON to **stdout** (the cluster's log shipper
collects it; app code never ships logs itself). Every line is
stamped with the service name and, inside a request scope, the verified
``tenant_id`` / ``workspace_id`` and the active OTel ``trace_id`` so a single
tenant's request can be followed across the fleet and isolation proven.

``trace_id`` is the OTel/W3C-standard field name a log backend keys a derived field
on, so logs pivot to traces. It is sourced from the **active span**
(not the request-domain ``correlation_id``), so it is always a real 32-hex trace
id that joins to the trace backend, or it is absent — never a fabricated value. The
``correlation_id`` request-domain concept stays out of the log schema (see
``context.current_context``).

This is what makes "turn on logging" free: a service that already logs to stdout
gets centralized, queryable, identity-tagged logs the moment a log backend collects stdout.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import MutableMapping
from typing import Any

import structlog
from opentelemetry import trace

from .context import current_context


def _inject_context(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog processor: merge the request-scoped identity facts."""
    event_dict.update(current_context())
    return event_dict


def _inject_trace_id(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog processor: stamp the active span's OTel ``trace_id``.

    Runs at log-emit time (inside the request span the FastAPI instrumentation
    opens), so it reads the real trace id — unlike the middleware, which runs
    outside the span. Omitted when there is no valid active span, so a present
    ``trace_id`` is always a 32-hex id that joins to the trace backend.
    """
    span_context = trace.get_current_span().get_span_context()
    if span_context.is_valid:
        event_dict["trace_id"] = format(span_context.trace_id, "032x")
    return event_dict


#: The HTTP client loggers that write a request's full URL at INFO.
_URL_LOGGING_CLIENTS = ("httpx", "httpcore", "httpx2", "httpcore2")


#: The processors every line runs through, structlog's own and stdlib's foreign ones alike.
_SHARED_PROCESSORS: list[Any] = [
    structlog.contextvars.merge_contextvars,
    structlog.processors.add_log_level,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
    _inject_context,
    _inject_trace_id,
    structlog.processors.StackInfoRenderer(),
    structlog.processors.format_exc_info,
]

#: The process's structlog chain: one list, built once, and never replaced. A logger
#: configured with ``cache_logger_on_first_use`` keeps the list it first ran with, so a new
#: list would strand every logger already used on the old one.
_CHAIN: list[Any] = [*_SHARED_PROCESSORS, structlog.stdlib.ProcessorFormatter.wrap_for_formatter]


def _install_chain() -> None:
    """Point structlog at ``_CHAIN``, unless it already is.

    Checked by identity rather than with a flag, so a process whose structlog configuration
    was reset or replaced since gets the chain back on its next call.
    """
    if structlog.get_config()["processors"] is _CHAIN:
        return
    structlog.configure(
        processors=_CHAIN,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )


def configure_logging(service: str, *, level: str = "INFO") -> None:
    """Configure stdlib + structlog to emit JSON to stdout with context stamping.

    The structlog chain is the process's and is installed once (``_install_chain``); a later
    call, from a second app instrumented in the same process, changes only what is per call:
    the level, the root handler, and the service bound onto every line. Routes stdlib logging
    (uvicorn, sqlalchemy, etc.) through the same renderer so the whole process speaks one log
    format.
    """
    _install_chain()

    # Route stdlib logging (uvicorn / libraries) through the same JSON renderer.
    #
    # ``ExtraAdder`` is what makes ``logger.info("event", extra={"k": v})`` — the stdlib
    # idiom — reach the line at all. ``ProcessorFormatter`` builds its event dict from
    # ``record.getMessage()`` alone, so without it the call emits the line and silently DROPS
    # the field: no error, and code that reads as though it worked.
    #
    # It runs FIRST so that what follows can overwrite it. ``tenant_id`` / ``workspace_id`` /
    # ``caller`` are bound from the verified edge headers and never from a caller, and the log
    # line is where that binding is read back — so ``extra`` must not be able to name a tenant
    # the request did not carry. ``_inject_context`` re-applies them after this.
    #
    # It re-applies only what is BOUND — ``current_context()`` omits anything unset — so the
    # ordering protects a field exactly where there is a verified value to restore. An unbound
    # one has nothing behind it and the caller's ``extra`` stands: every line outside a request
    # scope, and ``caller`` on any service that does not opt into a ``caller_resolver``.
    # Closing that takes a reserved-key processor rather than an ordering.
    #
    # ``service`` and ``event`` are NOT protected by the ordering, and the reason is worth
    # knowing before someone relies on one: ``merge_contextvars`` seeds from the bound vars and
    # then lets the event dict win, and ``event`` is set before the chain and never re-set. A
    # caller naming either still overrides it.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=[structlog.stdlib.ExtraAdder(), *_SHARED_PROCESSORS],
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())

    # httpx / httpcore log each request at INFO with the full request URL, and so do
    # httpx2 / httpcore2, the fork FastMCP's own HTTP runs on. A provider
    # that authenticates with the key in a query parameter would otherwise leak that
    # secret through the root handler into the logs. Pin them to WARNING once, so no
    # request URL (and no key) is ever logged by any service that calls this. The RED
    # metrics + each service's own tool logging already cover request observability.
    #
    # Scope: this covers the httpx family, under both package names. A client that
    # authenticates via headers and doesn't log URLs at INFO needs nothing. If one ever
    # logs a query-param key, add a source-agnostic redaction filter on the handler
    # rather than another per-library pin.
    for name in _URL_LOGGING_CLIENTS:
        logging.getLogger(name).setLevel(logging.WARNING)

    # Bind the service name onto every line via a permanent context var.
    structlog.contextvars.bind_contextvars(service=service)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """A structured logger. Identity/correlation are injected automatically."""
    return structlog.stdlib.get_logger(name)
