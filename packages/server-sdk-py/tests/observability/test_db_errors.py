"""How a database error is recognised and rendered, on exceptions built to each driver's shape.

The real Postgres errors are in ``tests/db/test_error_redaction.py``; these cover the shapes
that suite cannot raise: psycopg's diagnostics object, an exception group, a context chain,
and each form ``exc_info`` takes.
"""

from __future__ import annotations

import sys
from typing import Any

import pytest

from nimblebrain_server_sdk.observability._db_errors import (
    WITHHELD,
    database_error_fields,
    redact_database_errors,
    redact_exception_event,
    render_without_messages,
)

CANARY = "jane@acme.example"


class UniqueViolationError(Exception):
    sqlstate = "23505"
    constraint_name = "people_email_key"
    table_name = "people"


UniqueViolationError.__module__ = "asyncpg.exceptions"


class _Diag:
    sqlstate = "23502"
    column_name = "phone"
    table_name = "people"


class NotNullViolation(Exception):
    sqlstate = None
    diag = _Diag()


NotNullViolation.__module__ = "psycopg.errors"


class Subclassed(UniqueViolationError):
    """A server's own subclass is a database error through its base."""


Subclassed.__module__ = "svc.errors"


def _raised(exc: BaseException) -> BaseException:
    try:
        raise exc
    except BaseException as caught:  # noqa: BLE001
        return caught


def _event(exc_info: Any) -> dict[str, Any]:
    return dict(redact_database_errors(None, "error", {"event": "e", "exc_info": exc_info}))


def test_psycopg_diagnostics_are_read() -> None:
    fields = database_error_fields(NotNullViolation(CANARY))
    assert fields == {"sqlstate": "23502", "column": "phone", "table": "people"}


def test_a_value_that_is_not_a_sqlstate_is_dropped() -> None:
    exc = UniqueViolationError(CANARY)
    exc.sqlstate = CANARY
    assert "sqlstate" not in database_error_fields(exc)


def test_a_subclass_defined_elsewhere_is_a_database_error() -> None:
    event = _event(Subclassed(CANARY))
    assert CANARY not in event["exception"]
    assert event["db_error"]["constraint"] == "people_email_key"


def test_a_context_chain_is_rendered_without_messages() -> None:
    try:
        try:
            raise UniqueViolationError(CANARY)
        except UniqueViolationError:
            raise KeyError(CANARY)  # noqa: B904
    except KeyError as exc:
        rendered = render_without_messages(exc)
    assert CANARY not in rendered
    assert "During handling of the above exception" in rendered
    assert f"KeyError: {WITHHELD}" in rendered


def test_an_exception_group_member_is_found_and_rendered() -> None:
    group = _raised(ExceptionGroup(CANARY, [UniqueViolationError(CANARY), ValueError(CANARY)]))
    event = _event(group)
    assert CANARY not in event["exception"]
    assert "+---------------- 1 ----------------" in event["exception"]
    assert event["db_error"]["sqlstate"] == "23505"


def test_exc_info_true_reads_the_handled_exception() -> None:
    try:
        raise UniqueViolationError(CANARY)
    except UniqueViolationError:
        event = _event(True)
    assert CANARY not in event["exception"]


def test_an_exc_info_tuple_is_read() -> None:
    exc = _raised(UniqueViolationError(CANARY))
    event = _event((type(exc), exc, exc.__traceback__))
    assert CANARY not in event["exception"]


@pytest.mark.parametrize("exc_info", [None, False, (None, None, None), ("odd",)])
def test_no_exception_leaves_the_event_alone(exc_info: Any) -> None:
    assert _event(exc_info)["exc_info"] == exc_info


def test_exc_info_true_with_nothing_handled_is_left_alone() -> None:
    assert sys.exc_info()[1] is None
    assert _event(True)["exc_info"] is True


def test_a_database_error_without_fields_adds_no_db_error() -> None:
    bare = type("InterfaceError", (Exception,), {"__module__": "asyncpg.exceptions"})
    event = _event(bare(CANARY))
    assert "db_error" not in event
    assert CANARY not in event["exception"]


def test_a_span_event_named_by_a_chained_header_is_redacted() -> None:
    stacktrace = (
        "Traceback (most recent call last):\n"
        '  File "/srv/app.py", line 3, in insert\n'
        "    run()\n"
        f"asyncpg.exceptions.UniqueViolationError: dup\nDETAIL:  Key (email)=({CANARY})\n\n"
        "The above exception was the direct cause of the following exception:\n\n"
        f"RuntimeError: insert failed: {CANARY}\n"
    )
    redacted = redact_exception_event(
        {
            "exception.type": "RuntimeError",
            "exception.message": f"insert failed: {CANARY}",
            "exception.stacktrace": stacktrace,
        }
    )
    assert redacted is not None
    assert CANARY not in str(redacted)
    assert redacted["exception.stacktrace"] == f"RuntimeError: {WITHHELD}"


def test_a_span_event_without_a_stacktrace_keeps_none() -> None:
    redacted = redact_exception_event(
        {"exception.type": "sqlalchemy.exc.IntegrityError", "exception.message": CANARY}
    )
    assert redacted == {
        "exception.type": "sqlalchemy.exc.IntegrityError",
        "exception.message": WITHHELD,
    }


def test_the_exporter_redacts_a_span_whose_status_has_no_description() -> None:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from nimblebrain_server_sdk.observability.tracing import RedactingSpanExporter

    inner = InMemorySpanExporter()
    exporter = RedactingSpanExporter(inner)
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    with provider.get_tracer("t").start_as_current_span("s", record_exception=False) as span:
        span.add_event("checkpoint")
        span.record_exception(UniqueViolationError(CANARY))

    (finished,) = inner.get_finished_spans()
    assert CANARY not in finished.to_json()
    assert finished.events[0].name == "checkpoint"
    assert not finished.status.description
    assert exporter.force_flush()
    exporter.shutdown()
    assert inner.export([]) is SpanExportResult.FAILURE  # the inner exporter was shut down


def _exported(exc: BaseException) -> str:
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from nimblebrain_server_sdk.observability.tracing import RedactingSpanExporter

    inner = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(inner)))
    with provider.get_tracer("t").start_as_current_span("s", record_exception=False) as span:
        span.record_exception(exc)
    (finished,) = inner.get_finished_spans()
    return finished.to_json()


def test_the_exporter_redacts_a_database_error_inside_an_exception_group() -> None:
    inner = _raised(UniqueViolationError(f"dup\nDETAIL:  Key (email)=({CANARY})"))
    group = _raised(BaseExceptionGroup("batch failed", [ValueError("other"), inner]))
    assert CANARY not in _exported(group)


def test_the_exporter_redacts_a_database_error_inside_a_nested_group() -> None:
    inner = _raised(UniqueViolationError(f"dup\nDETAIL:  Key (email)=({CANARY})"))
    group = _raised(BaseExceptionGroup("outer", [BaseExceptionGroup("inner", [inner])]))
    assert CANARY not in _exported(group)


def test_the_exporter_keeps_no_frame_shaped_line_of_a_database_message() -> None:
    message = f'dup\nDETAIL:\n  File "{CANARY}", line 1, in value'
    assert CANARY not in _exported(_raised(UniqueViolationError(message)))
